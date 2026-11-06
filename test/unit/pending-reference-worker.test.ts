import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, type WagerTransactionState } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { pendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { FinancialStore, FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import type { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { PersistenceInvariantError } from '../../src/shared/application/application-errors';
import type { OperationalRecord } from '../../src/shared/application/operational-logging';

const at = new Date('2035-01-01T00:00:00Z'); const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
function harness() {
  const wallet = Wallet.rehydrate({ id: randomUUID(), playerId: 'player-test-01', currency: 'BRL', balance: money('90.00'), version: 2, createdAt: at, updatedAt: at });
  const base = { id: randomUUID(), walletId: wallet.id, playerId: wallet.playerId, providerId: 'provider', externalTransactionId: 'refund',
    idempotencyKey: 'refund-key', payloadHash: 'a'.repeat(64), roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Refund,
    money: money('10.00'), referenceExternalTransactionId: 'bet', createdAt: at };
  const state: WagerTransactionState = { ...base, status: WagerTransactionStatus.PendingReference, attempts: 0,
    nextRetryAt: new Date(at.getTime() + 1000), expiresAt: new Date(at.getTime() + 86400000), recordedBalance: money('100.00') };
  let tx = WagerTransaction.rehydrate(state);
  let reference: WagerTransaction | undefined = WagerTransaction.rehydrate({ ...base, id: randomUUID(), externalTransactionId: 'bet',
    idempotencyKey: 'bet-key', kind: WagerTransactionKind.Bet, referenceExternalTransactionId: undefined, status: WagerTransactionStatus.Processed,
    processedAt: at, recordedBalance: money('90.00') });
  let now = new Date(at.getTime() + 1000); const calls: string[] = []; const events: OutboxMessage[] = [];
  let reversed = false;
  const store: Partial<FinancialStore> = {
    getWallet: async (id, lock) => { calls.push('wallet-lock'); expect(id).toBe(wallet.id); expect(lock).toBe(true); return wallet; },
    getWager: async (id, lock) => { calls.push(id === tx.id ? (lock ? 'wager-lock' : 'wager-read') : 'reference-lock');
      if (id !== tx.id) expect(lock).toBe(true); return id === tx.id ? tx : reference; },
    findWager: async () => { calls.push('reference-read'); return reference; },
    isReversed: async () => reversed,
    updateWallet: async () => { calls.push('wallet-write'); },
    updatePendingWager: async () => { calls.push('wager-write'); return true; },
    appendLedger: async () => { calls.push('ledger'); }, enqueue: async event => { events.push(event); },
    findDuePendingWagers: async (time, limit) => { calls.push('discovery'); expect(time).toEqual(now); expect(limit).toBe(100); return [tx]; },
  };
  const uow: FinancialUnitOfWork = { run: async work => { calls.push('begin'); const value = await work(store as FinancialStore); calls.push('commit'); return value; } };
  const worker = new PendingReferenceWorker(uow, { now: () => now }, pendingReferencePolicy({}), { diagnose: () => {} });
  return { wallet, state, store, uow, worker, calls, events, candidate: { id: tx.id, walletId: wallet.id },
    tx: () => tx, setTx: (s: Partial<WagerTransactionState>) => { tx = WagerTransaction.rehydrate({ ...state, ...s }); },
    setRef: (ref: WagerTransaction | undefined) => { reference = ref; }, ref: () => reference!,
    setNow: (value: Date) => { now = value; }, setReversed: () => { reversed = true; } };
}
test('wallet is locked before wager and same-wallet reference; valid refund produces atomic artifacts', async () => {
  const h = harness(); expect((await h.worker.resolve(h.candidate)).action).toBe('processed');
  expect(h.calls.indexOf('wallet-lock')).toBeLessThan(h.calls.indexOf('wager-lock'));
  expect(h.calls.indexOf('wager-lock')).toBeLessThan(h.calls.indexOf('reference-lock'));
  expect(h.calls).toContain('wallet-write'); expect(h.calls).toContain('wager-write'); expect(h.calls).toContain('ledger');
  expect(h.calls.at(-1)).toBe('commit'); expect(h.wallet.balance.toString()).toBe('100.00'); expect(h.wallet.version).toBe(3);
  expect(h.tx().status).toBe(WagerTransactionStatus.Processed); expect(h.tx().recordedBalance?.toString()).toBe('100.00');
  expect(h.events.map(e => e.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  expect(new Set(h.events.map(e => e.id)).size).toBe(2);
  expect(h.events.every(e => e.payload['correlationId'] === h.candidate.id && e.payload['causationId'] === h.candidate.id)).toBe(true);
});
test('terminal or rescheduled candidate is revalidated under locks and becomes no-op', async () => {
  const h = harness(); h.setTx({ status: WagerTransactionStatus.Processed, nextRetryAt: undefined, expiresAt: undefined });
  expect((await h.worker.resolve(h.candidate)).action).toBe('noop'); expect(h.events).toEqual([]);
  const other = harness(); other.setNow(at); expect((await other.worker.resolve(other.candidate)).action).toBe('noop');
  expect(other.calls).not.toContain('reference-read');
});
test('clock is read after waiting for the wallet lock, so newly due work is processed', async () => {
  const h = harness(); h.setNow(at); const original = h.store.getWallet!;
  h.store.getWallet = async (...args) => { const w = await original(...args); h.setNow(new Date(at.getTime() + 1000)); return w; };
  expect((await h.worker.resolve(h.candidate)).action).toBe('processed');
});
test('missing reference reschedules before deadline and preserves acceptance balance with no financial event', async () => {
  const h = harness(); h.setRef(undefined);
  expect((await h.worker.resolve(h.candidate)).action).toBe('rescheduled'); expect(h.tx().attempts).toBe(1);
  expect(h.tx().nextRetryAt?.getTime()).toBe(at.getTime() + 3000); expect(h.tx().recordedBalance?.toString()).toBe('100.00');
  expect(h.wallet.balance.toString()).toBe('90.00'); expect(h.calls).not.toContain('ledger'); expect(h.events).toEqual([]);
});
test('temporarily pending reference waits instead of being permanently rejected', async () => {
  const h = harness(); const r = h.ref();
  h.setRef(WagerTransaction.rehydrate({ ...h.state, id: r.id, externalTransactionId: 'bet', kind: WagerTransactionKind.Bet,
    referenceExternalTransactionId: undefined, status: WagerTransactionStatus.Pending, nextRetryAt: undefined, expiresAt: undefined }));
  expect((await h.worker.resolve(h.candidate)).action).toBe('rescheduled'); expect(h.tx().failureCode).toBeUndefined();
});
test('terminal invalid reference rejects with original domain code and no movement', async () => {
  const h = harness(); const r = h.ref();
  h.setRef(WagerTransaction.rehydrate({ ...h.state, id: r.id, externalTransactionId: 'bet', kind: WagerTransactionKind.Bet,
    referenceExternalTransactionId: undefined, status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFundsBet }));
  expect((await h.worker.resolve(h.candidate)).action).toBe('rejected'); expect(h.tx().failureCode).toBe(FailureCode.ReferenceNotProcessed);
  expect(h.calls).not.toContain('ledger'); expect(h.events.map(e => e.eventType)).toEqual(['WagerTransactionRejected']);
});
test.each(['ttl', 'attempts', 'backoff-equal', 'backoff-after'] as const)('timeout %s never passes an invalid retry Date to domain', async mode => {
  const h = harness(); h.setRef(undefined);
  if (mode === 'ttl') h.setNow(h.state.expiresAt!);
  if (mode === 'attempts') h.setTx({ attempts: 9 });
  if (mode === 'backoff-equal') h.setTx({ expiresAt: new Date(at.getTime() + 3000) });
  if (mode === 'backoff-after') h.setTx({ expiresAt: new Date(at.getTime() + 2999) });
  expect((await h.worker.resolve(h.candidate)).action).toBe('rejected');
  expect(h.tx().failureCode).toBe(FailureCode.ReferenceNotFoundTimeout); expect(h.tx().nextRetryAt).toBeUndefined();
  expect(h.tx().recordedBalance?.toString()).toBe('90.00'); expect(h.events[0]?.eventType).toBe('WagerTransactionRejected');
});
test('already reversed reference is rejected without second credit', async () => {
  const h = harness(); h.setReversed(); expect((await h.worker.resolve(h.candidate)).action).toBe('rejected');
  expect(h.tx().failureCode).toBe(FailureCode.ReferenceAlreadyReversed); expect(h.wallet.balance.toString()).toBe('90.00');
});
test('cross-wallet reference never acquires another financial lock', async () => {
  const h = harness(); const ref = h.ref();
  h.setRef(WagerTransaction.rehydrate({ ...h.state, id: ref.id, walletId: randomUUID(), externalTransactionId: 'bet',
    kind: WagerTransactionKind.Bet, referenceExternalTransactionId: undefined, status: WagerTransactionStatus.Processed }));
  expect((await h.worker.resolve(h.candidate)).action).toBe('rejected'); expect(h.tx().failureCode).toBe(FailureCode.ReferenceContextMismatch);
  expect(h.calls).not.toContain('reference-lock'); expect(h.calls.filter(c => c === 'wallet-lock')).toHaveLength(1);
});
test('unexpected zero-row update aborts instead of committing a partial wallet movement', async () => {
  const h = harness(); h.store.updatePendingWager = async () => false;
  await expect(h.worker.resolve(h.candidate)).rejects.toBeInstanceOf(PersistenceInvariantError); expect(h.calls).not.toContain('commit');
  expect(h.events).toEqual([]);
});
test('transaction retries use fresh reads and do not count infra failure as a reference attempt', async () => {
  const h = harness(); const original = h.store.getWallet!; let count = 0;
  h.store.getWallet = async (...args) => { if (++count === 1) throw { code: '40P01' }; return original(...args); };
  expect((await h.worker.resolve(h.candidate)).action).toBe('processed'); expect(count).toBe(2); expect(h.tx().attempts).toBe(0);
});
test('discovery failure for one candidate is diagnosed safely; no forced terminal failure', async () => {
  const h = harness(); h.store.getWallet = async () => { throw new Error('never-log-credential'); };
  const diagnostics: unknown[] = [];
  const worker = new PendingReferenceWorker(h.uow, { now: () => h.state.nextRetryAt! }, pendingReferencePolicy({}), { diagnose: e => diagnostics.push(e) });
  expect(await worker.runOnce()).toEqual([{ transactionId: h.candidate.id, action: 'retry' }]);
  expect(JSON.stringify(diagnostics)).not.toContain('never-log-credential'); expect(h.tx().status).toBe(WagerTransactionStatus.PendingReference);
});
test('initial financial use case shares the configured pending schedule', async () => {
  const h = harness(); h.setRef(undefined);
  const store = h.store;
  store.findIdentity = async () => []; store.claimInbox = async () => { throw new Error('no inbox on this input'); };
  let inserted: WagerTransaction | undefined; store.insertWager = async tx => { inserted = tx; };
  const process = new ProcessWagerTransactionUseCase(h.uow, { now: () => at,
    pendingReferencePolicy: { baseDelayMs: 20, maxAttempts: 3, ttlMs: 500 } });
  await process.execute({ walletId: h.wallet.id, playerId: h.wallet.playerId, providerId: 'provider', externalTransactionId: 'refund',
    idempotencyKey: 'refund-key', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Refund,
    money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet', correlationId: 'corr' });
  expect(inserted?.nextRetryAt?.getTime()).toBe(at.getTime() + 20); expect(inserted?.expiresAt?.getTime()).toBe(at.getTime() + 500);
});

test('valid reference resolves on last permitted check and after a delayed scan; TTL only limits waiting', async () => {
  const last = harness(); last.setTx({ attempts: 9 }); expect((await last.worker.resolve(last.candidate)).action).toBe('processed');
  const delayed = harness(); delayed.setNow(delayed.state.expiresAt!);
  expect((await delayed.worker.resolve(delayed.candidate)).action).toBe('processed');
});

test('inconsistent discovery candidate never locks the wager owned by another wallet', async () => {
  const h = harness(); h.setTx({ walletId: randomUUID() });
  await expect(h.worker.resolve(h.candidate)).rejects.toBeInstanceOf(PersistenceInvariantError);
  expect(h.calls).not.toContain('wager-lock'); expect(h.calls).not.toContain('commit');
});

test('D02 credit overflow on late reference terminalizes as FAILED without partial credit, Outbox or infinite retry while healthy candidates progress', async () => {
  const maxWallet = Wallet.rehydrate({ id: randomUUID(), playerId: 'player-test-01', currency: 'BRL',
    balance: money('9999999999999999.99'), version: 3, createdAt: at, updatedAt: at });
  const healthyWallet = Wallet.rehydrate({ id: randomUUID(), playerId: 'player-test-02', currency: 'BRL',
    balance: money('90.00'), version: 2, createdAt: at, updatedAt: at });
  const winId = randomUUID(); const betId = randomUUID();
  const refundId = randomUUID(); const healthyBetId = randomUUID();
  let win = WagerTransaction.rehydrate({ id: winId, walletId: maxWallet.id, playerId: maxWallet.playerId,
    providerId: 'provider', externalTransactionId: 'win-overflow', idempotencyKey: 'win-overflow-key',
    payloadHash: 'a'.repeat(64), roundId: 'round-max', gameId: 'game', kind: WagerTransactionKind.Win,
    money: money('20.00'), referenceExternalTransactionId: 'bet-max', createdAt: at,
    status: WagerTransactionStatus.PendingReference, attempts: 0,
    nextRetryAt: new Date(at.getTime() + 1000), expiresAt: new Date(at.getTime() + 86400000),
    recordedBalance: money('9999999999999990.00') });
  const bet = WagerTransaction.rehydrate({ id: betId, walletId: maxWallet.id, playerId: maxWallet.playerId,
    providerId: 'provider', externalTransactionId: 'bet-max', idempotencyKey: 'bet-max-key',
    payloadHash: 'b'.repeat(64), roundId: 'round-max', gameId: 'game', kind: WagerTransactionKind.Bet,
    money: money('10.00'), createdAt: at, status: WagerTransactionStatus.Processed,
    processedAt: at, recordedBalance: money('9999999999999980.00') });
  let refund = WagerTransaction.rehydrate({ id: refundId, walletId: healthyWallet.id, playerId: healthyWallet.playerId,
    providerId: 'provider', externalTransactionId: 'refund-healthy', idempotencyKey: 'refund-healthy-key',
    payloadHash: 'c'.repeat(64), roundId: 'round-healthy', gameId: 'game', kind: WagerTransactionKind.Refund,
    money: money('10.00'), referenceExternalTransactionId: 'bet-healthy', createdAt: at,
    status: WagerTransactionStatus.PendingReference, attempts: 0,
    nextRetryAt: new Date(at.getTime() + 1000), expiresAt: new Date(at.getTime() + 86400000),
    recordedBalance: money('90.00') });
  const healthyBet = WagerTransaction.rehydrate({ id: healthyBetId, walletId: healthyWallet.id, playerId: healthyWallet.playerId,
    providerId: 'provider', externalTransactionId: 'bet-healthy', idempotencyKey: 'bet-healthy-key',
    payloadHash: 'd'.repeat(64), roundId: 'round-healthy', gameId: 'game', kind: WagerTransactionKind.Bet,
    money: money('10.00'), createdAt: at, status: WagerTransactionStatus.Processed,
    processedAt: at, recordedBalance: money('90.00') });
  const now = new Date(at.getTime() + 1000);
  const calls: string[] = []; const events: OutboxMessage[] = [];
  const logs: OperationalRecord[] = []; const diagnostics: unknown[] = [];
  const store: Partial<FinancialStore> = {
    findDuePendingWagers: async () => [win, refund].filter(tx => tx.status === WagerTransactionStatus.PendingReference),
    getWallet: async (id, lock) => {
      expect(lock).toBe(true);
      if (id === maxWallet.id) return maxWallet;
      if (id === healthyWallet.id) return healthyWallet;
      return undefined;
    },
    getWager: async id => {
      if (id === win.id) return win;
      if (id === bet.id) return bet;
      if (id === refund.id) return refund;
      if (id === healthyBet.id) return healthyBet;
      return undefined;
    },
    findWager: async (_providerId, externalId) => {
      if (externalId === 'bet-max') return bet;
      if (externalId === 'bet-healthy') return healthyBet;
      return undefined;
    },
    isReversed: async () => false,
    updateWallet: async updated => { calls.push(`wallet-write:${updated.id}`); },
    updatePendingWager: async updated => {
      calls.push(`wager-write:${updated.id}:${updated.status}`);
      if (updated.id === win.id) win = updated;
      if (updated.id === refund.id) refund = updated;
      return true;
    },
    appendLedger: async entry => { calls.push(`ledger:${entry.transactionId}`); },
    enqueue: async event => { events.push(event); },
  };
  const uow: FinancialUnitOfWork = { run: async work => work(store as FinancialStore) };
  const worker = new PendingReferenceWorker(uow, { now: () => now }, pendingReferencePolicy({}), {
    diagnose: event => diagnostics.push(event),
    operationalLog: record => { logs.push(record); },
  });
  expect(await worker.runOnce()).toEqual([
    { transactionId: win.id, action: 'failed' },
    { transactionId: refund.id, action: 'processed' },
  ]);
  expect(win.status).toBe(WagerTransactionStatus.Failed);
  expect(win.failureCode).toBe(FailureCode.InfrastructurePermanent);
  expect(win.recordedBalance?.toString()).toBe('9999999999999999.99');
  expect(win.nextRetryAt).toBeUndefined();
  expect(win.expiresAt).toBeUndefined();
  expect(maxWallet.balance.toString()).toBe('9999999999999999.99');
  expect(maxWallet.version).toBe(3);
  expect(calls).not.toContain(`wallet-write:${maxWallet.id}`);
  expect(calls).not.toContain(`ledger:${win.id}`);
  expect(healthyWallet.balance.toString()).toBe('100.00');
  expect(healthyWallet.version).toBe(3);
  expect(refund.status).toBe(WagerTransactionStatus.Processed);
  expect(events.map(e => e.aggregateId)).toEqual([healthyWallet.id, healthyWallet.id]);
  expect(logs).toHaveLength(2);
  expect(logs[0]).toMatchObject({ component: 'pending-reference-worker', event: 'pending_reference_resolved',
    transactionId: win.id, walletId: maxWallet.id, status: 'FAILED', code: 'INFRASTRUCTURE_PERMANENT' });
  expect(diagnostics).toEqual([{ component: 'pending-reference-worker', code: 'MONEY_OVERFLOW', transactionId: win.id }]);
  expect(await worker.runOnce()).toEqual([]);
  expect(await worker.resolve({ id: win.id, walletId: maxWallet.id })).toEqual({ transactionId: win.id, action: 'noop' });
});

test('D02 credit overflow after TTL or on last attempt still terminalizes as FAILED (never REFERENCE_NOT_FOUND_TIMEOUT) and aborts if update fails', async () => {
  for (const mode of ['last-attempt', 'after-ttl', 'zero-row-abort'] as const) {
    const h = harness();
    const maxWallet = Wallet.rehydrate({ id: h.wallet.id, playerId: h.wallet.playerId, currency: 'BRL',
      balance: money('9999999999999999.99'), version: 3, createdAt: at, updatedAt: at });
    h.store.getWallet = async () => maxWallet;
    h.setTx({
      kind: WagerTransactionKind.Win,
      money: money('20.00'),
      attempts: mode === 'last-attempt' ? 9 : 0,
      recordedBalance: money('9999999999999990.00'),
    });
    if (mode === 'after-ttl') h.setNow(h.state.expiresAt!);
    if (mode === 'zero-row-abort') h.store.updatePendingWager = async () => false;
    const logs: OperationalRecord[] = []; const diagnostics: unknown[] = [];
    const worker = new PendingReferenceWorker(h.uow, { now: () => mode === 'after-ttl' ? h.state.expiresAt! : new Date(at.getTime() + 1000) },
      pendingReferencePolicy({}), { diagnose: event => diagnostics.push(event), operationalLog: record => { logs.push(record); } });
    if (mode === 'zero-row-abort') {
      await expect(worker.resolve(h.candidate)).rejects.toBeInstanceOf(PersistenceInvariantError);
      expect(logs).toEqual([]);
      expect(diagnostics).toEqual([]);
      expect(h.events).toEqual([]);
    } else {
      expect(await worker.resolve(h.candidate)).toEqual({ transactionId: h.candidate.id, action: 'failed' });
      expect(h.tx().status).toBe(WagerTransactionStatus.Failed);
      expect(h.tx().failureCode).toBe(FailureCode.InfrastructurePermanent);
      expect(h.tx().recordedBalance?.toString()).toBe('9999999999999999.99');
      expect(h.events).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(diagnostics).toEqual([{ component: 'pending-reference-worker', code: 'MONEY_OVERFLOW', transactionId: h.candidate.id }]);
    }
  }
});
