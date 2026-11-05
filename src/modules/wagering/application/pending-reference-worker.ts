import type { FinancialUnitOfWork } from '../../../shared/application/financial-store';
import type { ClockPort } from '../../../shared/application/clock';
import { PersistenceInvariantError } from '../../../shared/application/application-errors';
import { execution, exhausted, isTransient, retryDelay, type ExecutionOptions } from '../../../shared/application/execution';
import { internalId } from '../../../shared/application/identifiers';
import { dateCopy } from '../../../shared/domain/validation';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { evaluateWager, type WagerDecision } from '../domain/wager-rules';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { nextReferenceRetry, pendingReferencePolicy, validatePendingReferencePolicy, type PendingReferencePolicy } from './pending-reference-policy';
import { operationalEmitter, type OperationalLoggingOptions } from '../../../shared/application/operational-logging';

export interface PendingCandidate { readonly id: string; readonly walletId: string }
export interface PendingResolution { readonly transactionId: string; readonly action: 'processed' | 'rejected' | 'rescheduled' | 'noop' | 'retry' }
export interface PendingWorkerOptions extends Omit<ExecutionOptions, 'now'>, OperationalLoggingOptions {
  readonly diagnose?: (event: { readonly component: 'pending-reference-worker'; readonly code: string; readonly transactionId?: string }) => void;
}
export class PendingReferenceWorker {
  private readonly runtime;
  private readonly policy: PendingReferencePolicy;
  private readonly diagnose: NonNullable<PendingWorkerOptions['diagnose']>;
  private readonly observe;
  constructor(private readonly uow: FinancialUnitOfWork, private readonly clock: ClockPort,
    policy: PendingReferencePolicy = pendingReferencePolicy(), options: PendingWorkerOptions = {}) {
    this.policy = validatePendingReferencePolicy(policy);
    this.runtime = execution({ ...options, now: () => this.clock.now() });
    this.observe = operationalEmitter(options.operationalLog);
    this.diagnose = options.diagnose ?? (event => console.log(JSON.stringify(event)));
  }
  async runOnce(limit = 100, signal?: AbortSignal): Promise<PendingResolution[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid pending candidate limit');
    if (signal?.aborted) return [];
    const candidates = await this.uow.run(store => store.findDuePendingWagers(dateCopy(this.clock.now()), limit));
    const results: PendingResolution[] = [];
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      try { results.push(await this.resolve(candidate)); }
      catch {
        this.log('RESOLUTION_RETRY', candidate.id);
        results.push({ transactionId: candidate.id, action: 'retry' });
      }
    }
    return results;
  }
  async resolve(candidate: PendingCandidate): Promise<PendingResolution> {
    const walletId = internalId(candidate.walletId); const transactionId = internalId(candidate.id);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.uow.run<PendingResolution>(async store => {
          const wallet = await store.getWallet(walletId, true); // Always the FIRST financial lock.
          if (!wallet) throw new PersistenceInvariantError('Pending wager wallet is missing');
          // Candidate discovery is nonlocking. Verify ownership without locking another wallet's wager,
          // even if a stale/invalid internal caller supplies an inconsistent candidate.
          const preview = await store.getWager(transactionId);
          if (!preview) return { transactionId, action: 'noop' };
          if (preview.walletId !== wallet.id) throw new PersistenceInvariantError('Pending candidate wallet mismatch');
          const tx = await store.getWager(transactionId, true); // Never lock a wager before its wallet.
          if (!tx) return { transactionId, action: 'noop' };
          if (tx.walletId !== wallet.id) throw new PersistenceInvariantError('Pending candidate wallet mismatch');
          if (tx.status !== WagerTransactionStatus.PendingReference) return { transactionId, action: 'noop' };
          if (!tx.nextRetryAt || !tx.expiresAt || !tx.expectsReference()) throw new PersistenceInvariantError('Invalid persisted reference schedule');
          // Re-read time AFTER any lock wait, not from the discovery snapshot.
          const now = dateCopy(this.clock.now());
          if (tx.nextRetryAt.getTime() > now.getTime() && tx.expiresAt.getTime() > now.getTime()) return { transactionId, action: 'noop' };
          let reference = await store.findWager(tx.providerId, tx.referenceExternalTransactionId!);
          if (reference?.walletId === wallet.id) reference = await store.getWager(reference.id, true);
          // Cross-wallet references are read-only and rejected by the original pure evaluator.
          // TTL limits waiting for an unavailable reference; it does not replace valid financial/reference rules.
          let decision: WagerDecision = evaluateWager(tx, { walletId: wallet.id, playerId: wallet.playerId, balance: wallet.balance,
            ...(reference ? { reference } : {}), referenceAlreadyReversed: reference?.walletId === wallet.id ? await store.isReversed(reference.id) : false });
          if (decision.status === 'PENDING_REFERENCE') {
            const next = nextReferenceRetry({ attempts: tx.attempts, nextRetryAt: tx.nextRetryAt, expiresAt: tx.expiresAt }, now, this.policy);
            if (next) {
              tx.reschedulePendingReference(next);
              if (!await store.updatePendingWager(tx)) throw new PersistenceInvariantError('Pending reschedule did not affect one row');
              await this.runtime.checkpoint('wager'); await this.runtime.checkpoint('beforeCommit');
              // Status and acceptance snapshot did not change; no repeated status event on every timer retry.
              return { transactionId, action: 'rescheduled' };
            }
            decision = { status: 'REJECTED', code: FailureCode.ReferenceNotFoundTimeout };
          }
          let entry: WalletLedgerEntry | undefined;
          if (decision.status === 'PROCESSED') {
            if (decision.direction) {
              const movement = { transactionId: tx.id, ledgerEntryId: this.runtime.newId(), money: tx.money, at: now };
              entry = decision.direction === LedgerDirection.Debit
                ? wallet.debit({ ...movement, insufficientFundsCode: FailureCode.InsufficientFundsReversal }) : wallet.credit(movement);
              await store.updateWallet(wallet);
            }
            await this.runtime.checkpoint('wallet');
            tx.markProcessed(reference?.id, now, wallet.balance);
          } else tx.reject(decision.code, wallet.balance);
          if (!await store.updatePendingWager(tx)) throw new PersistenceInvariantError('Pending transition did not affect one row');
          await this.runtime.checkpoint('wager');
          if (entry) await store.appendLedger(entry);
          await this.runtime.checkpoint('ledger');
          // Original request correlation is not a Wager field. Stable transaction identity links worker events.
          const context = () => ({ eventId: this.runtime.newId(), correlationId: tx.id, causationId: tx.id, occurredAt: now });
          const event = decision.status === 'PROCESSED' ? WagerTransactionProcessed.from(tx, context()) : WagerTransactionRejected.from(tx, context());
          await store.enqueue(OutboxMessage.enqueue(event));
          if (entry) await store.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context())));
          await this.runtime.checkpoint('outbox'); await this.runtime.checkpoint('beforeCommit');
          return { transactionId, action: decision.status === 'PROCESSED' ? 'processed' : 'rejected' };
        });
        if (result.action !== 'noop') this.observe({ component: 'pending-reference-worker',
          event: result.action === 'rescheduled' ? 'pending_reference_rescheduled' : 'pending_reference_resolved',
          transactionId, walletId, status: result.action });
        return result;
      } catch (error) {
        if (!isTransient(error)) throw error;
        if (attempt + 1 >= this.runtime.maxAttempts) throw exhausted(error);
        await retryDelay(attempt); // A new UoW context on every transaction attempt.
      }
    }
  }
  async run(signal: AbortSignal, pollMs = 250, batchSize = 100): Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60000) throw new Error('Invalid pending poll interval');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Invalid pending batch size');
    while (!signal.aborted) {
      try { await this.runOnce(batchSize, signal); } catch { this.log('DISCOVERY_RETRY'); }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, pollMs); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
      });
    }
  }
  private log(code: string, transactionId?: string): void {
    try { this.diagnose({ component: 'pending-reference-worker', code, ...(transactionId ? { transactionId } : {}) }); } catch { /* diagnostic only */ }
  }
}
