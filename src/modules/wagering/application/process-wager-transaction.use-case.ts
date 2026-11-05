import { initialReferenceSchedule, pendingReferencePolicy, validatePendingReferencePolicy, type PendingReferencePolicy } from './pending-reference-policy';
import type { FinancialStore, FinancialUnitOfWork } from '../../../shared/application/financial-store';
import { NotFoundError, PersistenceInvariantError, sqlError } from '../../../shared/application/application-errors';
import { execution, exhausted, isTransient, retryDelay, type ExecutionOptions } from '../../../shared/application/execution';
import { internalId } from '../../../shared/application/identifiers';
import { IdempotencyConflictError, InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { dateCopy, requireText } from '../../../shared/domain/validation';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed';
import { evaluateWager } from '../domain/wager-rules';
import { WagerTransaction, type WagerTransactionStatus } from '../domain/wager-transaction';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { FailureCode } from '../domain/failure-code';
import { wagerPayloadHash, type WagerPayload } from './wager-payload';
import { operationalEmitter, type OperationalLoggingOptions } from '../../../shared/application/operational-logging';

export interface ProcessWagerOptions extends ExecutionOptions, OperationalLoggingOptions { readonly pendingReferencePolicy?: PendingReferencePolicy }
export interface ProcessWagerInput extends WagerPayload {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly inbox?: { readonly consumerName: string; readonly messageId: string; readonly receivedAt: Date };
}
export interface ProcessWagerResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}
const BUSINESS_UNIQUES = new Set(['uq_wager_idempotency', 'uq_wager_provider_external']);
export class ProcessWagerTransactionUseCase {
  private readonly runtime;
  private readonly referencePolicy: PendingReferencePolicy;
  private readonly observe;
  constructor(private readonly uow: FinancialUnitOfWork, options: ProcessWagerOptions = {}) {
    this.runtime = execution(options);
    this.observe = operationalEmitter(options.operationalLog);
    this.referencePolicy = validatePendingReferencePolicy(options.pendingReferencePolicy ?? pendingReferencePolicy());
  }
  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const normalized = { ...input, walletId: internalId(input.walletId), money: Money.from(input.money).toJSON() };
    requireText(input.correlationId, 'correlationId');
    const payloadHash = wagerPayloadHash(normalized);
    const identity = { providerId: input.providerId, externalTransactionId: input.externalTransactionId, idempotencyKey: input.idempotencyKey, payloadHash };
    const at = dateCopy(this.runtime.now());
    const transactionId = this.runtime.newId();
    const props = { ...normalized, id: transactionId, money: Money.from(normalized.money), payloadHash, createdAt: at };
    // Validate all external domain rules before opening a database transaction.
    WagerTransaction.create(props);
    const received = input.inbox && InboxMessage.receive({ ...input.inbox, payloadHash });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.uow.run(async store => {
            // Read-only identity checks ensure an already-used key conflicts even for a missing target wallet.
            this.matchWinner(await store.findIdentity(identity.idempotencyKey, identity.providerId, identity.externalTransactionId), identity);
            const wallet = await store.getWallet(normalized.walletId, true); // FIRST acquired financial lock.
            if (!wallet) {
              this.matchWinner(await store.findIdentity(identity.idempotencyKey, identity.providerId, identity.externalTransactionId), identity);
              throw new NotFoundError('Wallet not found');
            }
            let inbox: InboxMessage | undefined;
            let newInbox = false;
            if (received) {
              const claim = await store.claimInbox(received); // BEFORE wager locks or inserts.
              inbox = claim.message; newInbox = claim.inserted;
              inbox.assertSamePayload(payloadHash);
              if (!newInbox && !inbox.isProcessed()) throw new PersistenceInvariantError('Committed Inbox is unprocessed');
            }
            const winner = this.matchWinner(await store.findIdentity(identity.idempotencyKey, identity.providerId, identity.externalTransactionId), identity);
            if (winner) {
              if (inbox && newInbox) { inbox.markProcessed(at); await store.finishInbox(inbox); await this.runtime.checkpoint('inbox'); }
              await this.runtime.checkpoint('beforeCommit');
              return this.result(winner, true);
            }
            if (inbox && !newInbox) throw new PersistenceInvariantError('Processed Inbox has no matching wager');
            if (wallet.playerId !== input.playerId) throw new InvalidDomainInputError('Wallet does not belong to player');
            const tx = WagerTransaction.create(props); // Fresh object for every attempt.
            let reference = tx.expectsReference() ? await store.findWager(tx.providerId, tx.referenceExternalTransactionId!) : undefined;
            if (reference?.walletId === wallet.id) reference = await store.getWager(reference.id, true);
            // Never lock the other wallet or its wager for an invalid cross-wallet reference.
            const decision = evaluateWager(tx, { walletId: wallet.id, playerId: wallet.playerId, balance: wallet.balance,
              ...(reference ? { reference } : {}), referenceAlreadyReversed: reference?.walletId === wallet.id ? await store.isReversed(reference.id) : false });
            const context = () => ({ eventId: this.runtime.newId(), correlationId: input.correlationId, causationId: input.causationId, occurredAt: at });
            let entry: WalletLedgerEntry | undefined;
            if (decision.status === 'PROCESSED') {
              if (decision.direction) {
                const movement = { transactionId: tx.id, ledgerEntryId: this.runtime.newId(), money: tx.money, at };
                entry = decision.direction === LedgerDirection.Debit
                  ? wallet.debit({ ...movement, insufficientFundsCode: tx.kind === 'BET' ? FailureCode.InsufficientFundsBet : FailureCode.InsufficientFundsReversal })
                  : wallet.credit(movement);
                await store.updateWallet(wallet);
              }
              await this.runtime.checkpoint('wallet');
              tx.markProcessed(tx.expectsReference() ? reference?.id : undefined, at, wallet.balance);
            } else if (decision.status === 'REJECTED') tx.reject(decision.code, wallet.balance);
            else tx.markPendingReference(wallet.balance, initialReferenceSchedule(at, this.referencePolicy));
            await store.insertWager(tx); await this.runtime.checkpoint('wager');
            if (entry) await store.appendLedger(entry);
            await this.runtime.checkpoint('ledger');
            const event = decision.status === 'PROCESSED' ? WagerTransactionProcessed.from(tx, context())
              : decision.status === 'REJECTED' ? WagerTransactionRejected.from(tx, context()) : WagerTransactionPendingReference.from(tx, context());
            await store.enqueue(OutboxMessage.enqueue(event));
            if (entry) await store.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context())));
            await this.runtime.checkpoint('outbox');
            if (inbox) { inbox.markProcessed(at); await store.finishInbox(inbox); }
            await this.runtime.checkpoint('inbox');
            await this.runtime.checkpoint('beforeCommit');
            return this.result(tx, false);
          });
          this.observe({ component: 'wagering', event: result.idempotentReplay ? 'wager_replayed'
            : result.status === 'PROCESSED' ? 'wager_processed' : result.status === 'REJECTED' ? 'wager_rejected' : 'wager_pending_reference',
            transactionId: result.transactionId, walletId: normalized.walletId, providerId: input.providerId,
            correlationId: input.correlationId, status: result.status, code: result.failureCode, idempotentReplay: result.idempotentReplay });
          return result;
        } catch (error) {
          const sql = sqlError(error);
          const businessCollision = sql.code === '23505' && BUSINESS_UNIQUES.has(sql.constraint ?? '');
          if (businessCollision) {
            // The aborted context is gone. Re-read the winner without locking its wallet.
            await this.uow.run(async store => {
              this.matchWinner(await store.findIdentity(identity.idempotencyKey, identity.providerId, identity.externalTransactionId), identity);
            });
          } else if (!isTransient(error)) throw error;
          if (attempt + 1 >= this.runtime.maxAttempts) throw exhausted(error);
          await retryDelay(attempt); // No locks or transaction held while waiting.
        }
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) this.observe({ component: 'wagering', event: 'idempotency_conflict',
        code: 'IDEMPOTENCY_CONFLICT', walletId: normalized.walletId, providerId: input.providerId, correlationId: input.correlationId });
      throw error;
    }
  }
  private matchWinner(rows: WagerTransaction[], identity: Parameters<WagerTransaction['assertReplay']>[0]): WagerTransaction | undefined {
    if (rows.length > 1) throw new IdempotencyConflictError('Key and external ID identify different operations');
    rows[0]?.assertReplay(identity);
    return rows[0];
  }
  private result(tx: WagerTransaction, replay: boolean): ProcessWagerResult {
    if (!tx.recordedBalance) throw new PersistenceInvariantError('Persisted response snapshot is missing');
    return { transactionId: tx.id, status: tx.status, balance: tx.recordedBalance.toJSON(),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}), idempotentReplay: replay };
  }
}
