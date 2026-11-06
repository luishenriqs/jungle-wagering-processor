import 'reflect-metadata';
import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import type { FinancialStore, FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import { Money } from '../../src/shared/domain/money';
import { IdempotencyConflictError } from '../../src/shared/domain/domain-errors';
import { ConflictError, RetryExhaustedError } from '../../src/shared/application/application-errors';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { ProcessWagerTransactionUseCase, type ProcessWagerInput, type ProcessWagerResult } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { pendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { wagerPayloadHash } from '../../src/modules/wagering/application/wager-payload';
import { SqsWagerConsumer } from '../../src/modules/messaging/application/sqs-wager-consumer';
import type { SqsConsumerTransport } from '../../src/modules/messaging/application/sqs-transport';
import { consumerConfig } from '../../src/modules/messaging/application/consumer-config';
import { OutboxPublisher } from '../../src/modules/messaging/application/outbox-publisher';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { AppModule } from '../../src/app.module';
import { operationalEvents } from '../../src/shared/application/operational-logging';
import {
  DefaultOperationalMetricsCollector,
  reduceConcurrencyConflict,
  reduceSaturatedCounter,
  reduceTimeAggregate,
  type OperationalMetricObservation,
  type OperationalMetricsTimeAggregate,
} from '../../src/shared/application/operational-metrics';
import { DatabaseModule } from '../../src/database/database.module';
import { MessagingModule } from '../../src/modules/messaging/messaging.module';
import { WageringModule } from '../../src/modules/wagering/wagering.module';

// RED fixtures use only baseline modules. This local contract mirrors the homologated
// port without importing its not-yet-implemented production type.
type MetricObservation =
  | { readonly type: 'wager-status'; readonly status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED' }
  | { readonly type: 'duplicate'; readonly kind: 'replay' | 'conflict' }
  | { readonly type: 'retry-scheduled'; readonly target: 'wagerUow' | 'walletUow' | 'pendingReference' | 'sqsConsumer' | 'outboxPublisher' }
  | { readonly type: 'concurrency-conflict'; readonly code: '40P01' | '40001' | '55P03' | '57014' | '23505' }
  | { readonly type: 'dlq-transfer-confirmed' }
  | { readonly type: 'outbox-publication-confirmed'; readonly lagMs: number }
  | { readonly type: 'processing-duration'; readonly durationMs: number }
  | { readonly type: 'pending-reference-resolution'; readonly action: 'processed' | 'rejected' | 'rescheduled' }
  | { readonly type: 'reconciliation-divergence' };
type Observation = (event: MetricObservation) => unknown;
function capture() { const values: MetricObservation[] = []; return { values, observe: (event: MetricObservation) => { values.push(event); } }; }
function money(amount: string) { return Money.from({ amount, currency: 'BRL' }); }
const at = new Date('2026-11-05T12:00:00.000Z');
const correlationId = randomUUID();

function financial(balance = '100.00') {
  const wallet = Wallet.rehydrate({ id: randomUUID(), playerId: 'player-metrics-test', currency: 'BRL', balance: money(balance), version: 1, createdAt: at, updatedAt: at });
  const inserted: WagerTransaction[] = []; const entries: unknown[] = []; const outbox: OutboxMessage[] = []; const calls: string[] = [];
  const identities: WagerTransaction[] = [];
  const store: Partial<FinancialStore> = {
    getWallet: async id => id === wallet.id ? wallet : undefined,
    insertWallet: async () => { calls.push('insertWallet'); }, updateWallet: async () => { calls.push('updateWallet'); },
    findIdentity: async (key, providerId, externalId) => identities.filter(tx =>
      (tx.idempotencyKey === key && tx.providerId === providerId)
      || (tx.providerId === providerId && tx.externalTransactionId === externalId)),
    getWager: async id => identities.find(tx => tx.id === id), findWager: async () => undefined, isReversed: async () => false,
    insertWager: async tx => { inserted.push(tx); identities.push(tx); calls.push('insertWager'); },
    appendLedger: async entry => { entries.push(entry); calls.push('appendLedger'); },
    enqueue: async event => { outbox.push(event); calls.push('enqueue'); },
    claimInbox: async message => ({ inserted: true, message }), finishInbox: async () => {},
    ledgerPage: async () => [], ledgerTotal: async () => ({ amount: wallet.balance.toString(), count: entries.length }),
    findDuePendingWagers: async () => [], claimNextOutbox: async () => undefined,
    completeOutbox: async () => true, failOutbox: async () => true,
  };
  const uow: FinancialUnitOfWork = { run: async work => { calls.push('uow:start'); const result = await work(store as FinancialStore); calls.push('uow:commit'); return result; } };
  const input: ProcessWagerInput = { walletId: wallet.id, playerId: wallet.playerId, providerId: 'provider-test', externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(), roundId: 'round-test', gameId: 'game-test', kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' }, correlationId };
  return { wallet, store, uow, input, inserted, entries, outbox, calls, identities };
}

function historical(h: ReturnType<typeof financial>, amount = '25.00') {
  const input = { ...h.input, money: { amount, currency: 'BRL' } as const };
  return WagerTransaction.rehydrate({ ...input, id: randomUUID(), payloadHash: wagerPayloadHash(input), money: money(amount), createdAt: at,
    status: WagerTransactionStatus.Processed, processedAt: at, recordedBalance: money('75.00') });
}

async function pendingResolutionFixture(observe: Observation) {
  const h = financial('100.00');
  const input = { ...h.input, externalTransactionId: 'refund-metrics-test', idempotencyKey: 'refund-metrics-key',
    kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'reference-metrics-test', money: { amount: '10.00', currency: 'BRL' } };
  const options = { now: () => at, operationalMetrics: observe } as unknown as ConstructorParameters<typeof ProcessWagerTransactionUseCase>[1];
  const accepted = await new ProcessWagerTransactionUseCase(h.uow, options).execute(input);
  const pending = h.identities.find(tx => tx.id === accepted.transactionId)!;
  let reference: WagerTransaction | undefined;
  h.store.findWager = async (_providerId, externalTransactionId) => externalTransactionId === 'reference-metrics-test' ? reference : undefined;
  h.store.updatePendingWager = async updated => {
    const index = h.identities.findIndex(tx => tx.id === updated.id);
    if (index < 0) return false;
    h.identities[index] = updated;
    return true;
  };
  const setReference = (status: 'processed' | 'rejected' | 'missing') => {
    if (status === 'missing') { reference = undefined; return; }
    const referenceInput = { ...input, externalTransactionId: 'reference-metrics-test', idempotencyKey: 'reference-metrics-key',
      kind: WagerTransactionKind.Bet, referenceExternalTransactionId: undefined };
    reference = WagerTransaction.rehydrate({ ...referenceInput, id: randomUUID(), payloadHash: wagerPayloadHash(referenceInput),
      money: money('10.00'), createdAt: at, status: status === 'processed' ? WagerTransactionStatus.Processed : WagerTransactionStatus.Rejected,
      ...(status === 'processed' ? { processedAt: at } : { failureCode: FailureCode.InsufficientFundsBet }), recordedBalance: money('90.00') });
    h.identities.push(reference);
  };
  return { h, input, pending, setReference, reference: () => reference,
    worker: (uow: FinancialUnitOfWork = h.uow) => new PendingReferenceWorker(uow, { now: () => new Date(at.getTime() + 2000) },
      pendingReferencePolicy({}), { operationalMetrics: observe } as unknown as ConstructorParameters<typeof PendingReferenceWorker>[3]) };
}

function requestOptions(uow: FinancialUnitOfWork, extras: Record<string, unknown> = {}) {
  return AppModule.register({ uow, ...extras } as unknown as Parameters<typeof AppModule.register>[0]);
}
async function startHttp(uow: FinancialUnitOfWork, extras: Record<string, unknown> = {}) {
  const app = await NestFactory.create(requestOptions(uow, extras), { logger: false, abortOnError: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl(), close: () => app.close() };
}
async function metrics(app: { getUrl(): Promise<string> } | { url: string }) {
  const url = 'url' in app ? app.url : await app.getUrl();
  return fetch(`${url}/metrics`);
}

const bucketZero = { le5Ms: 0, le10Ms: 0, le25Ms: 0, le50Ms: 0, le100Ms: 0, le250Ms: 0, le500Ms: 0, le1000Ms: 0, gt1000Ms: 0 };
const timeZero = { count: 0, totalMs: 0, minMs: 0, maxMs: 0, lastMs: 0, buckets: bucketZero };
const emptySnapshot = {
  scope: 'process',
  transactionsByStatus: { PROCESSED: 0, REJECTED: 0, PENDING_REFERENCE: 0, FAILED: 0 },
  duplicates: { replays: 0, conflicts: 0 },
  retries: { wagerUow: 0, walletUow: 0, pendingReference: 0, sqsConsumer: 0, outboxPublisher: 0 },
  dlq: { confirmedTransfers: 0 },
  concurrencyConflicts: { total: 0, byCode: { '40P01': 0, '40001': 0, '55P03': 0, '57014': 0, '23505': 0 } },
  outboxLagMs: timeZero, processingDurationMs: timeZero,
  reconciliation: { divergences: 0 }, pendingReference: { processed: 0, rejected: 0, rescheduled: 0 },
};

test('RED-C01 GET /metrics returns the exact approved JSON contract without financial auth or I/O', async () => {
  const calls: string[] = []; const uow: FinancialUnitOfWork = { run: async () => { calls.push('uow'); throw new Error('must not run'); } };
  const h = await startHttp(uow);
  try {
    const response = await metrics(h); expect(calls).toEqual([]);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(emptySnapshot);
  } finally { await h.close(); }
});

test('RED-C01 GET /metrics rejects unknown query parameters with INVALID_INPUT', async () => {
  const h = await startHttp({ run: async () => { throw new Error('must not run'); } });
  try { const response = await fetch(`${h.url}/metrics?unexpected=1`); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' }); }
  finally { await h.close(); }
});

test('RED-C02 rollback is not counted; only confirmed PROCESSED, REJECTED and PENDING_REFERENCE outcomes appear', async () => {
  const h = financial(); const realRun = h.uow.run.bind(h.uow); let rolledBack = false;
  const uow: FinancialUnitOfWork = { run: async (work, isolation) => { if (!rolledBack) { rolledBack = true; throw { code: '40001' }; } return realRun(work, isolation); } };
  const app = await startHttp(uow);
  try {
    const processor = app.app.get(ProcessWagerTransactionUseCase);
    const processed = await processor.execute(h.input);
    expect(processed.status).toBe(WagerTransactionStatus.Processed); expect(h.entries).toHaveLength(1); expect(h.outbox.length).toBeGreaterThan(0);
    const rejected = await processor.execute({ ...h.input, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), money: { amount: '150.00', currency: 'BRL' } });
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    const pending = await processor.execute({ ...h.input, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'missing-reference' });
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    const response = await metrics(app); expect(response.status).toBe(200);
    const body = await response.json() as typeof emptySnapshot;
    expect(body.transactionsByStatus).toEqual({ PROCESSED: 1, REJECTED: 1, PENDING_REFERENCE: 1, FAILED: 0 });
    expect(body.retries.wagerUow).toBe(1);
  } finally { await app.close(); }
});

test('RED-C03 replay and definitive idempotency conflict have separate counters without duplicate movement', async () => {
  const h = financial(); const app = await startHttp(h.uow);
  try {
    const processor = app.app.get(ProcessWagerTransactionUseCase);
    const original = await processor.execute(h.input);
    expect(original.idempotentReplay).toBe(false); expect(h.entries).toHaveLength(1);
    const replay = await processor.execute(h.input);
    expect(replay.idempotentReplay).toBe(true); expect(replay.transactionId).toBe(original.transactionId); expect(h.entries).toHaveLength(1);
    await expect(processor.execute({ ...h.input, money: { amount: '26.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(h.inserted).toHaveLength(1); expect(h.outbox).toHaveLength(2);
    const response = await metrics(app); expect(response.status).toBe(200);
    const body = await response.json() as typeof emptySnapshot;
    expect(body.transactionsByStatus.PROCESSED).toBe(1); expect(body.duplicates).toEqual({ replays: 1, conflicts: 1 });
  } finally { await app.close(); }
});

test('RED-C04 retries count only a retry decision and recognized PostgreSQL conflict codes', async () => {
  const h = financial(); const realRun = h.uow.run.bind(h.uow); let calls = 0;
  const uow: FinancialUnitOfWork = { run: async (work, isolation) => { if (++calls === 1) throw { code: '40001' }; return realRun(work, isolation); } };
  const app = await startHttp(uow);
  try {
    const result = await app.app.get(ProcessWagerTransactionUseCase).execute(h.input);
    expect(result.status).toBe(WagerTransactionStatus.Processed); expect(calls).toBe(2); expect(h.inserted).toHaveLength(1);
    const response = await metrics(app); expect(response.status).toBe(200);
    const body = await response.json() as typeof emptySnapshot;
    expect(body.retries.wagerUow).toBe(1); expect(body.concurrencyConflicts).toEqual({ total: 1, byCode: { '40P01': 0, '40001': 1, '55P03': 0, '57014': 0, '23505': 0 } });
  } finally { await app.close(); }
});

for (const code of ['40P01', '40001', '55P03', '57014'] as const) {
  test(`RED-REV-04 recognized SQLSTATE ${code} is counted once on retry decision`, async () => {
    const h = financial(); const realRun = h.uow.run.bind(h.uow); let calls = 0;
    const uow: FinancialUnitOfWork = { run: async (work, isolation) => {
      if (++calls === 1) throw { code };
      return realRun(work, isolation);
    } };
    const app = await startHttp(uow);
    try {
      const result = await app.app.get(ProcessWagerTransactionUseCase).execute(h.input);
      expect(result.status).toBe(WagerTransactionStatus.Processed); expect(calls).toBe(2); expect(h.inserted).toHaveLength(1);
      const response = await metrics(app); expect(response.status).toBe(200);
      const body = await response.json() as typeof emptySnapshot;
      expect(body.retries.wagerUow).toBe(1);
      expect(body.concurrencyConflicts).toEqual({ total: 1, byCode: { '40P01': code === '40P01' ? 1 : 0,
        '40001': code === '40001' ? 1 : 0, '55P03': code === '55P03' ? 1 : 0, '57014': code === '57014' ? 1 : 0, '23505': 0 } });
    } finally { await app.close(); }
  });
}

test('RED-REV-04 CreateWallet counts its own transient UoW retry', async () => {
  const h = financial(); const realRun = h.uow.run.bind(h.uow); let calls = 0;
  const uow: FinancialUnitOfWork = { run: async (work, isolation) => {
    if (++calls === 1) throw { code: '55P03' };
    return realRun(work, isolation);
  } };
  const app = await startHttp(uow);
  try {
    const wallet = await app.app.get(CreateWalletUseCase).execute({ playerId: 'wallet-retry-metrics', initialBalance: { amount: '5.00', currency: 'BRL' }, correlationId });
    expect(wallet.balance.toString()).toBe('5.00'); expect(calls).toBe(2); expect(h.calls.filter(call => call === 'insertWallet')).toHaveLength(1);
    const response = await metrics(app); expect(response.status).toBe(200);
    const body = await response.json() as typeof emptySnapshot;
    expect(body.retries.walletUow).toBe(1); expect(body.concurrencyConflicts.byCode['55P03']).toBe(1);
  } finally { await app.close(); }
});

test('RED-REV-04 recognized wallet 23505 maps to the existing conflict and is not a retry', async () => {
  const h = financial(); const uow: FinancialUnitOfWork = { run: async () => { throw { code: '23505', constraint: 'uq_wallet_player_currency' }; } };
  const app = await startHttp(uow);
  try {
    await expect(app.app.get(CreateWalletUseCase).execute({ playerId: 'wallet-conflict-metrics', initialBalance: { amount: '5.00', currency: 'BRL' }, correlationId }))
      .rejects.toBeInstanceOf(ConflictError);
    const response = await metrics(app); expect(response.status).toBe(200);
    const body = await response.json() as typeof emptySnapshot;
    expect(body.retries.walletUow).toBe(0); expect(body.concurrencyConflicts).toEqual({ total: 1,
      byCode: { '40P01': 0, '40001': 0, '55P03': 0, '57014': 0, '23505': 1 } });
  } finally { await app.close(); }
});

for (const constraint of ['uq_wager_idempotency', 'uq_wager_provider_external'] as const) {
  test(`RED-REV-04 recognized Wager constraint ${constraint} replays its winner`, async () => {
    const h = financial(); const winner = historical(h); const realRun = h.uow.run.bind(h.uow); let firstAttempt = true; let insertAttempts = 0;
    h.store.insertWager = async () => {
      insertAttempts++;
      if (insertAttempts === 1) { h.identities.push(winner); throw { code: '23505', constraint }; }
      throw new Error('the concurrent winner should be replayed before a second insert');
    };
    const transactionalWallet = Wallet.rehydrate({ id: h.wallet.id, playerId: h.wallet.playerId, currency: h.wallet.currency,
      balance: h.wallet.balance, version: h.wallet.version, createdAt: at, updatedAt: at });
    const uow: FinancialUnitOfWork = { run: async (work, isolation) => {
      if (!firstAttempt) return realRun(work, isolation);
      firstAttempt = false;
      const isolatedStore = { ...(h.store as FinancialStore), getWallet: async () => transactionalWallet } as FinancialStore;
      return work(isolatedStore); // The synthetic unique winner is committed externally; this attempt's wallet clone is discarded.
    } };
    const app = await startHttp(uow);
    try {
      const replay = await app.app.get(ProcessWagerTransactionUseCase).execute(h.input);
      expect(replay.idempotentReplay).toBe(true); expect(replay.transactionId).toBe(winner.id);
      expect(h.wallet.balance.toString()).toBe('100.00'); expect(h.entries).toHaveLength(0); expect(h.outbox).toHaveLength(0);
      const response = await metrics(app); expect(response.status).toBe(200);
      const body = await response.json() as typeof emptySnapshot;
      expect(body.duplicates.replays).toBe(1); expect(body.retries.wagerUow).toBe(1); expect(body.concurrencyConflicts.byCode['23505']).toBe(1);
    } finally { await app.close(); }
  });
}

test('RED-REV-04 unknown 23505 is rethrown and does not count as a recognized concurrency conflict', async () => {
  const h = financial(); const uow: FinancialUnitOfWork = { run: async () => { throw { code: '23505', constraint: 'uq_unrecognized_test_constraint' }; } };
  const app = await startHttp(uow);
  try {
    let failure: unknown;
    try { await app.app.get(ProcessWagerTransactionUseCase).execute(h.input); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: '23505', constraint: 'uq_unrecognized_test_constraint' });
    expect(h.entries).toHaveLength(0); expect(h.outbox).toHaveLength(0);
    const response = await metrics(app); expect(response.status).toBe(200);
    const body = await response.json() as typeof emptySnapshot;
    expect(body.retries.wagerUow).toBe(0); expect(body.duplicates).toEqual({ replays: 0, conflicts: 0 });
    expect(body.concurrencyConflicts).toEqual({ total: 0, byCode: { '40P01': 0, '40001': 0, '55P03': 0, '57014': 0, '23505': 0 } });
  } finally { await app.close(); }
});

test('RED-REV-04 retry exhaustion leaves every transaction status uncommitted', async () => {
  let calls = 0; const uow: FinancialUnitOfWork = { run: async () => { calls++; throw { code: '40001' }; } };
  const app = await startHttp(uow);
  try {
    await expect(app.app.get(ProcessWagerTransactionUseCase).execute(financial().input)).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(3);
    const response = await metrics(app); expect(response.status).toBe(200);
    const body = await response.json() as typeof emptySnapshot;
    expect(body.transactionsByStatus).toEqual(emptySnapshot.transactionsByStatus);
    expect(body.retries.wagerUow).toBe(2); // The initial attempt is not a retry.
    expect(body.concurrencyConflicts).toEqual({ total: 3, byCode: { '40P01': 0, '40001': 3, '55P03': 0, '57014': 0, '23505': 0 } });
  } finally { await app.close(); }
});

for (const mode of ['processed', 'rejected', 'rescheduled'] as const) {
  test(`RED-REV-02 PendingReferenceWorker ${mode} is observed once without recounting M1`, async () => {
    const observe = capture(); const h = await pendingResolutionFixture(observe.observe);
    expect(h.pending.status).toBe(WagerTransactionStatus.PendingReference);
    const beforeResolution = observe.values.length;
    const beforeEntries = h.h.entries.length; const beforeOutbox = h.h.outbox.length;
    h.setReference(mode === 'rescheduled' ? 'missing' : mode);
    const result = await h.worker().resolve({ id: h.pending.id, walletId: h.h.wallet.id });
    expect(result.action).toBe(mode);
    if (mode === 'processed') {
      expect(h.pending.status).toBe(WagerTransactionStatus.Processed); expect(h.h.wallet.balance.toString()).toBe('110.00');
      expect(h.h.entries.length - beforeEntries).toBe(1); expect(h.h.outbox.length - beforeOutbox).toBe(2);
    } else if (mode === 'rejected') {
      expect(h.pending.status).toBe(WagerTransactionStatus.Rejected); expect(h.pending.failureCode).toBe(FailureCode.ReferenceNotProcessed);
      expect(h.h.wallet.balance.toString()).toBe('100.00'); expect(h.h.entries.length - beforeEntries).toBe(0); expect(h.h.outbox.length - beforeOutbox).toBe(1);
    } else {
      expect(h.pending.status).toBe(WagerTransactionStatus.PendingReference); expect(h.pending.attempts).toBe(1);
      expect(h.h.wallet.balance.toString()).toBe('100.00'); expect(h.h.entries.length - beforeEntries).toBe(0); expect(h.h.outbox.length - beforeOutbox).toBe(0);
    }
    // Business effects are asserted first; a late resolution is not a second M1 event.
    expect(observe.values.slice(beforeResolution)).toEqual([{ type: 'pending-reference-resolution', action: mode }]);
    expect(observe.values.filter(event => event.type === 'wager-status')).toEqual([
      { type: 'wager-status', status: 'PENDING_REFERENCE' },
    ]);
  });
}

test('RED-REV-02 PendingReferenceWorker noop emits no metric observation', async () => {
  const observe = capture(); const h = await pendingResolutionFixture(observe.observe); h.setReference('processed');
  const reference = h.reference(); expect(reference).toBeDefined();
  h.pending.markProcessed(reference!.id, at, h.h.wallet.balance);
  const beforeNoop = observe.values.length;
  expect((await h.worker().resolve({ id: h.pending.id, walletId: h.h.wallet.id })).action).toBe('noop');
  expect(observe.values.slice(beforeNoop)).toEqual([]);
});

test('RED-REV-02 PendingReferenceWorker retry and eventual resolution have separate observations', async () => {
  const observe = capture(); const h = await pendingResolutionFixture(observe.observe); h.setReference('processed');
  const realRun = h.h.uow.run.bind(h.h.uow); let calls = 0;
  const retryUow: FinancialUnitOfWork = { run: async (work, isolation) => {
    if (++calls === 1) throw { code: '40P01' };
    return realRun(work, isolation);
  } };
  const beforeResolution = observe.values.length;
  const result = await h.worker(retryUow).resolve({ id: h.pending.id, walletId: h.h.wallet.id });
  expect(result.action).toBe('processed'); expect(calls).toBe(2); expect(h.h.wallet.balance.toString()).toBe('110.00');
  expect(observe.values.slice(beforeResolution)).toEqual([
    { type: 'concurrency-conflict', code: '40P01' },
    { type: 'retry-scheduled', target: 'pendingReference' },
    { type: 'pending-reference-resolution', action: 'processed' },
  ]);
  expect(observe.values.filter(event => event.type === 'wager-status')).toEqual([
    { type: 'wager-status', status: 'PENDING_REFERENCE' },
  ]);
});

test('RED-C05 Consumer retry and confirmed DLQ are counted only after their transport decisions', async () => {
  const h = financial(); const transportCalls: string[] = []; const transport: SqsConsumerTransport = {
    receive: async () => undefined, acknowledge: async () => { transportCalls.push('ack'); }, retry: async () => { transportCalls.push('retry'); },
    deadLetter: async () => { transportCalls.push('dlq'); },
  };
  const observed: MetricObservation[] = []; const observe = (event: MetricObservation) => { observed.push(event); };
  const metricsOptions = { operationalMetrics: observe } as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5];
  const validEnvelope = JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), correlationId, occurredAt: at.toISOString(), data: h.input });
  const retryConsumer = new SqsWagerConsumer({ execute: async () => { throw { code: '40001' }; } }, transport, { now: () => at }, consumerConfig({}), () => {}, metricsOptions);
  const retry = await retryConsumer.handle({ body: validEnvelope, transportMessageId: randomUUID(), receiptHandle: 'receipt-test', receiveCount: 1 });
  expect(retry.action).toBe('retry'); expect(transportCalls).toEqual(['retry']);
  const observationsAfterRetry = observed.length;
  expect(observed).toEqual([{ type: 'retry-scheduled', target: 'sqsConsumer' }]);
  const dlqConsumer = new SqsWagerConsumer({ execute: async () => { throw new Error('must not process malformed message'); } }, transport, { now: () => at }, consumerConfig({}), () => {}, metricsOptions);
  const dead = await dlqConsumer.handle({ body: '{bad-json', transportMessageId: randomUUID(), receiptHandle: 'receipt-test-2', receiveCount: 3 });
  expect(dead.action).toBe('dead-lettered'); expect(transportCalls.slice(1)).toEqual(['dlq', 'ack']);
  expect(observed.slice(observationsAfterRetry)).toEqual([{ type: 'dlq-transfer-confirmed' }]);
});

for (const mode of ['dead-letter-send-fails', 'source-ack-fails', 'dead-letter-and-ack-succeed'] as const) {
  test(`RED-REV-03 Consumer DLQ confirmation boundary: ${mode}`, async () => {
    const calls: string[] = []; const observe = capture();
    const transport: SqsConsumerTransport = { receive: async () => undefined,
      acknowledge: async () => { calls.push('ack'); if (mode === 'source-ack-fails') throw new Error('synthetic ack failure'); },
      retry: async () => { calls.push('retry'); },
      deadLetter: async () => { calls.push('dlq'); if (mode === 'dead-letter-send-fails') throw new Error('synthetic DLQ send failure'); } };
    const options = { operationalMetrics: observe.observe } as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5];
    const consumer = new SqsWagerConsumer({ execute: async () => { throw new Error('malformed input must not reach processor'); } }, transport,
      { now: () => at }, consumerConfig({}), () => {}, options);
    const outcome = await consumer.handle({ body: '{malformed', transportMessageId: randomUUID(), receiptHandle: 'dlq-boundary-test', receiveCount: 3 });
    if (mode === 'dead-letter-and-ack-succeed') {
      expect(outcome).toMatchObject({ action: 'dead-lettered', code: 'INVALID_INPUT' }); expect(calls).toEqual(['dlq', 'ack']);
    } else {
      expect(outcome).toMatchObject({ action: 'retry', code: mode === 'dead-letter-send-fails' ? 'DLQ_SEND_FAILED' : 'DLQ_ACK_FAILED' });
      expect(calls).toEqual(mode === 'dead-letter-send-fails' ? ['dlq', 'retry'] : ['dlq', 'ack', 'retry']);
    }
    // A failed intermediate DLQ step is not a transfer; the subsequent confirmed retry is separate.
    expect(observe.values).toEqual(mode === 'dead-letter-and-ack-succeed'
      ? [{ type: 'dlq-transfer-confirmed' }]
      : [{ type: 'retry-scheduled', target: 'sqsConsumer' }]);
  });
}

test('RED-REV-03 Consumer retry metric requires transport.retry confirmation', async () => {
  const h = financial(); const observe = capture(); const envelope = JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(),
    correlationId, occurredAt: at.toISOString(), data: h.input });
  const transport: SqsConsumerTransport = { receive: async () => undefined, acknowledge: async () => {},
    retry: async () => { throw new Error('synthetic visibility update failure'); }, deadLetter: async () => {} };
  const options = { operationalMetrics: observe.observe } as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5];
  const consumer = new SqsWagerConsumer({ execute: async () => { throw { code: '40001' }; } }, transport,
    { now: () => at }, consumerConfig({}), () => {}, options);
  const outcome = await consumer.handle({ body: envelope, transportMessageId: randomUUID(), receiptHandle: 'retry-boundary-test', receiveCount: 1 });
  expect(outcome.action).toBe('retry'); expect(observe.values).toEqual([]);
});

test('RED-C06 Outbox lag is observed once only after successful SQL confirmation', async () => {
  const h = financial(); const eventId = randomUUID(); const occurredAt = new Date(at.getTime() - 120);
  const message = OutboxMessage.rehydrate({ id: eventId, aggregateId: h.wallet.id, eventType: 'WalletBalanceChanged', occurredAt, attempts: 0, nextAttemptAt: at,
    payload: { eventId, eventType: 'WalletBalanceChanged', occurredAt: occurredAt.toISOString(), correlationId, data: {} } });
  const calls: string[] = []; const observe = capture();
  const store = { claimNextOutbox: async () => ({ message, workerId: 'test-worker', leaseToken: randomUUID(), leaseUntil: new Date(at.getTime() + 10_000) }),
    completeOutbox: async () => { calls.push('complete'); return true; }, failOutbox: async () => true };
  const uow: FinancialUnitOfWork = { run: async work => work(store as unknown as FinancialStore) };
  const opts = { workerId: 'metrics-test', operationalMetrics: observe.observe } as unknown as ConstructorParameters<typeof OutboxPublisher>[4];
  const publisher = new OutboxPublisher(uow, { publish: async () => { calls.push('publish'); } }, { now: () => at }, workerConfig({}), opts);
  expect((await publisher.publishNext()).action).toBe('published'); expect(calls).toEqual(['publish', 'complete']);
  expect(observe.values).toEqual([{ type: 'outbox-publication-confirmed', lagMs: 120 }]);
});

for (const mode of ['send-confirmed-retry', 'send-retry-not-confirmed', 'fenced-confirmation', 'confirmation-error'] as const) {
  test(`RED-REV-03 Outbox metric boundary: ${mode}`, async () => {
    const eventId = randomUUID(); const occurredAt = new Date(at.getTime() - 120); const calls: string[] = []; const observe = capture();
    const message = OutboxMessage.rehydrate({ id: eventId, aggregateId: randomUUID(), eventType: 'WalletBalanceChanged', occurredAt,
      attempts: 0, nextAttemptAt: at, payload: { eventId, eventType: 'WalletBalanceChanged', occurredAt: occurredAt.toISOString(), correlationId, data: {} } });
    const store = {
      claimNextOutbox: async () => ({ message, workerId: 'metrics-rev03', leaseToken: randomUUID(), leaseUntil: new Date(at.getTime() + 10_000) }),
      completeOutbox: async () => { calls.push('complete'); if (mode === 'fenced-confirmation') return false;
        if (mode === 'confirmation-error') throw new Error('synthetic confirmation failure'); return true; },
      failOutbox: async () => { calls.push('fail'); return mode === 'send-confirmed-retry'; },
    };
    const uow: FinancialUnitOfWork = { run: async work => work(store as unknown as FinancialStore) };
    const options = { workerId: 'metrics-rev03', operationalMetrics: observe.observe } as unknown as ConstructorParameters<typeof OutboxPublisher>[4];
    const publisher = new OutboxPublisher(uow, { publish: async () => { calls.push('publish');
      if (mode === 'send-confirmed-retry' || mode === 'send-retry-not-confirmed') throw new Error('synthetic SQS send failure'); } },
    { now: () => at }, workerConfig({}), options);
    const outcome = await publisher.publishNext();
    if (mode === 'send-confirmed-retry') {
      expect(outcome.action).toBe('retry-scheduled'); expect(calls).toEqual(['publish', 'fail']);
      expect(observe.values).toEqual([{ type: 'retry-scheduled', target: 'outboxPublisher' }]);
    } else if (mode === 'send-retry-not-confirmed') {
      expect(outcome.action).toBe('lease-lost'); expect(calls).toEqual(['publish', 'fail']); expect(observe.values).toEqual([]);
    } else if (mode === 'fenced-confirmation') {
      expect(outcome.action).toBe('lease-lost'); expect(calls).toEqual(['publish', 'complete']); expect(observe.values).toEqual([]);
    } else {
      expect(outcome.action).toBe('confirmation-pending'); expect(calls).toEqual(['publish', 'complete']); expect(observe.values).toEqual([]);
    }
    // M6 is recorded only after completeOutbox returns true; failed/unconfirmed retry decisions are not counted.
  });
}

test('RED-REV-03 Consumer ack delegates M1/M2 to the financial use case without a generic ACK metric', async () => {
  const h = financial(); const observe = capture(); let financialObservations: MetricObservation[] = [];
  const processorOptions = { operationalMetrics: observe.observe } as unknown as ConstructorParameters<typeof ProcessWagerTransactionUseCase>[1];
  const processor = new ProcessWagerTransactionUseCase(h.uow, processorOptions);
  const wrappedProcessor = { execute: async (input: ProcessWagerInput) => {
    const before = observe.values.length; const result = await processor.execute(input);
    financialObservations = observe.values.slice(before); return result;
  } };
  const transportCalls: string[] = [];
  const transport: SqsConsumerTransport = { receive: async () => undefined,
    acknowledge: async () => { transportCalls.push('ack'); }, retry: async () => { transportCalls.push('retry'); }, deadLetter: async () => { transportCalls.push('dlq'); } };
  const consumerOptions = { operationalMetrics: observe.observe } as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5];
  const consumer = new SqsWagerConsumer(wrappedProcessor, transport, { now: () => at }, consumerConfig({}), () => {}, consumerOptions);
  const envelope = JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), correlationId, occurredAt: at.toISOString(), data: h.input });
  const result = await consumer.handle({ body: envelope, transportMessageId: randomUUID(), receiptHandle: 'ack-metrics-test', receiveCount: 1 });
  expect(result.action).toBe('acked'); expect(transportCalls).toEqual(['ack']);
  expect(h.entries).toHaveLength(1); expect(h.inserted).toHaveLength(1); expect(h.outbox.length).toBeGreaterThan(0);
  expect(financialObservations.map(event => event.type)).toEqual(['wager-status', 'processing-duration']);
  // The Consumer has no approved ACK counter and must not count the use-case result again as M1/M2.
  expect(observe.values).toEqual(financialObservations);
});

test('RED-C07 processing duration uses monotonic nonnegative observations and exclusive buckets', async () => {
  const h = financial(); const app = await startHttp(h.uow);
  try { const result = await app.app.get(ProcessWagerTransactionUseCase).execute(h.input);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    const response = await metrics(app); expect(response.status).toBe(200); const body = await response.json() as typeof emptySnapshot;
    const duration = body.processingDurationMs; expect(duration.count).toBe(1); expect(duration.totalMs).toBeGreaterThanOrEqual(duration.maxMs);
    expect(duration.minMs).toBeLessThanOrEqual(duration.maxMs); expect(duration.lastMs).toBeGreaterThanOrEqual(0);
    expect(Object.values(duration.buckets).reduce((a, b) => a + b, 0)).toBe(duration.count); }
  finally { await app.close(); }
});

test('RED-C08 metrics snapshot contains only fixed low-cardinality data and no sensitive values', async () => {
  const h = financial(); const app = await startHttp(h.uow);
  try { await app.app.get(CreateWalletUseCase).execute({ playerId: 'SYNTHETIC_PLAYER_SECRET', initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId });
    const response = await metrics(app); expect(response.status).toBe(200); const encoded = await response.text();
    expect(encoded).not.toContain('SYNTHETIC_PLAYER_SECRET'); expect(encoded).not.toContain('playerId'); expect(encoded).not.toContain('walletId');
    expect(JSON.parse(encoded)).toEqual(emptySnapshot); }
  finally { await app.close(); }
});

type ObserverFailure = 'sync-throw' | 'promise-reject' | 'then-getter-throws' | 'then-method-throws' | 'thenable-rejects' | 'never-resolves' | 'reentrant';
type ObservedComponent = 'CreateWalletUseCase' | 'ProcessWagerTransactionUseCase' | 'ReconcileWalletUseCase'
  | 'SqsWagerConsumer' | 'OutboxPublisher' | 'PendingReferenceWorker';
type MetricsInput = Observation | { readonly observe: Observation };

function metricsOption(input: MetricsInput): Record<string, unknown> { return { operationalMetrics: input }; }

function defectiveMetricsObserver(mode: ObserverFailure, calls: MetricObservation[], onCall: () => void) {
  let reentered = false;
  const observer: Observation = observation => {
    calls.push(observation);
    onCall();
    if (mode === 'sync-throw') throw new Error('synthetic metrics observer throw');
    if (mode === 'promise-reject') return Promise.reject(new Error('synthetic metrics observer rejection'));
    if (mode === 'then-getter-throws') return Object.defineProperty({}, 'then', { get() { throw new Error('synthetic then getter'); } });
    if (mode === 'then-method-throws') return { then() { throw new Error('synthetic then method'); } };
    if (mode === 'thenable-rejects') return { then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) { reject(new Error('synthetic thenable rejection')); } };
    if (mode === 'never-resolves') return new Promise<void>(() => {});
    // A bounded recursive callback exercises the synchronous reentrant path without
    // creating a test-owned infinite loop. Consecutive non-recursive emits remain separate.
    if (!reentered) { reentered = true; observer(observation); }
  };
  return observer;
}

function expectMetricPath(component: ObservedComponent, events: MetricObservation[]) {
  if (component === 'CreateWalletUseCase') {
    expect(events).toContainEqual({ type: 'concurrency-conflict', code: '55P03' });
    expect(events).toContainEqual({ type: 'retry-scheduled', target: 'walletUow' });
  } else if (component === 'ProcessWagerTransactionUseCase') {
    expect(events).toContainEqual({ type: 'concurrency-conflict', code: '40001' });
    expect(events).toContainEqual({ type: 'retry-scheduled', target: 'wagerUow' });
    expect(events).toContainEqual({ type: 'wager-status', status: 'PROCESSED' });
    expect(events.some(event => event.type === 'processing-duration' && Number.isFinite(event.durationMs) && event.durationMs >= 0)).toBe(true);
  } else if (component === 'ReconcileWalletUseCase') {
    expect(events).toContainEqual({ type: 'reconciliation-divergence' });
  } else if (component === 'SqsWagerConsumer') {
    expect(events).toContainEqual({ type: 'retry-scheduled', target: 'sqsConsumer' });
  } else if (component === 'OutboxPublisher') {
    expect(events).toContainEqual({ type: 'retry-scheduled', target: 'outboxPublisher' });
  } else {
    expect(events).toContainEqual({ type: 'wager-status', status: 'PENDING_REFERENCE' });
    expect(events).toContainEqual({ type: 'concurrency-conflict', code: '40P01' });
    expect(events).toContainEqual({ type: 'retry-scheduled', target: 'pendingReference' });
    expect(events).toContainEqual({ type: 'pending-reference-resolution', action: 'processed' });
    expect(events.some(event => event.type === 'processing-duration' && Number.isFinite(event.durationMs) && event.durationMs >= 0)).toBe(true);
  }
}

async function exerciseObservedComponent(component: ObservedComponent, observer: Observation): Promise<void> {
  const input: MetricsInput = component.charCodeAt(0) % 2 === 0 ? observer : { observe: observer };
  if (component === 'CreateWalletUseCase') {
    const h = financial(); const realRun = h.uow.run.bind(h.uow); let calls = 0;
    const retryUow: FinancialUnitOfWork = { run: async work => { if (++calls === 1) throw { code: '55P03' }; return realRun(work); } };
    const useCase = new CreateWalletUseCase(retryUow, metricsOption(input) as unknown as ConstructorParameters<typeof CreateWalletUseCase>[1]);
    const wallet = await useCase.execute({ playerId: 'observer-wallet', initialBalance: { amount: '10.00', currency: 'BRL' }, correlationId });
    expect(wallet.balance.toString()).toBe('10.00'); expect(h.calls).toContain('uow:commit'); expect(calls).toBe(2);
    return;
  }
  if (component === 'ProcessWagerTransactionUseCase') {
    const h = financial(); const realRun = h.uow.run.bind(h.uow); let calls = 0;
    const retryUow: FinancialUnitOfWork = { run: async (work, isolation) => { if (++calls === 1) throw { code: '40001' }; return realRun(work, isolation); } };
    const useCase = new ProcessWagerTransactionUseCase(retryUow, metricsOption(input) as unknown as ConstructorParameters<typeof ProcessWagerTransactionUseCase>[1]);
    const result = await useCase.execute(h.input);
    expect(result.status).toBe(WagerTransactionStatus.Processed); expect(h.wallet.balance.toString()).toBe('75.00');
    expect(h.entries).toHaveLength(1); expect(h.outbox).toHaveLength(2); expect(calls).toBe(2);
    return;
  }
  if (component === 'ReconcileWalletUseCase') {
    const h = financial(); h.store.ledgerTotal = async () => ({ amount: '99.00', count: 1 }); const legacy: unknown[] = [];
    const telemetry = { operationalMetrics: input,
      log: (event: { event: 'WalletReconciliationMismatch'; walletId: string; correlationId?: string }) => { legacy.push(event); } };
    const useCase = new ReconcileWalletUseCase(h.uow, telemetry as unknown as ConstructorParameters<typeof ReconcileWalletUseCase>[1]);
    const result = await useCase.execute(h.wallet.id, { correlationId });
    expect(result.consistent).toBe(false); expect(result.difference.amount).toBe('1.00'); expect(h.wallet.balance.toString()).toBe('100.00');
    expect(legacy).toHaveLength(1); return;
  }
  if (component === 'SqsWagerConsumer') {
    const calls: string[] = []; const transport: SqsConsumerTransport = { receive: async () => undefined, acknowledge: async () => {},
      retry: async () => { calls.push('retry'); }, deadLetter: async () => {} };
    const envelope = JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), correlationId, occurredAt: at.toISOString(), data: financial().input });
    const consumer = new SqsWagerConsumer({ execute: async () => { throw { code: '40001' }; } }, transport, { now: () => at }, consumerConfig({}), () => {},
      metricsOption(input) as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5]);
    const outcome = await consumer.handle({ body: envelope, transportMessageId: randomUUID(), receiptHandle: 'observer-test', receiveCount: 1 });
    expect(outcome).toMatchObject({ action: 'retry', code: 'POSTGRES_TRANSIENT' }); expect(calls).toEqual(['retry']); return;
  }
  if (component === 'OutboxPublisher') {
    const eventId = randomUUID(); const occurredAt = at;
    const message = OutboxMessage.rehydrate({ id: eventId, aggregateId: randomUUID(), eventType: 'WalletBalanceChanged', occurredAt,
      attempts: 0, nextAttemptAt: at, payload: { eventId, eventType: 'WalletBalanceChanged', occurredAt: at.toISOString(), data: {} } });
    const calls: string[] = []; const store = { claimNextOutbox: async () => ({ message, workerId: 'observer-test', leaseToken: randomUUID(), leaseUntil: new Date(at.getTime() + 10000) }),
      completeOutbox: async () => { calls.push('complete'); return true; }, failOutbox: async () => { calls.push('fail'); return true; } };
    const uow: FinancialUnitOfWork = { run: async work => work(store as unknown as FinancialStore) };
    const publisher = new OutboxPublisher(uow, { publish: async () => { calls.push('publish'); throw new Error('synthetic SQS send failure'); } },
      { now: () => at }, workerConfig({}), { workerId: 'observer-test', ...metricsOption(input), diagnose: () => {} } as unknown as ConstructorParameters<typeof OutboxPublisher>[4]);
    expect((await publisher.publishNext()).action).toBe('retry-scheduled'); expect(calls).toEqual(['publish', 'fail']); return;
  }
  const h = await pendingResolutionFixture(observer); h.setReference('processed');
  const realRun = h.h.uow.run.bind(h.h.uow); let attempts = 0;
  const retryUow: FinancialUnitOfWork = { run: async (work, isolation) => { if (++attempts === 1) throw { code: '40P01' }; return realRun(work, isolation); } };
  const useCase = h.worker(retryUow);
  const result = await useCase.resolve({ id: h.pending.id, walletId: h.h.wallet.id });
  expect(result.action).toBe('processed'); expect(attempts).toBe(2); expect(h.h.wallet.balance.toString()).toBe('110.00');
  expect(h.h.entries).toHaveLength(1);
}

const observerFailures: ObserverFailure[] = ['sync-throw', 'promise-reject', 'then-getter-throws', 'then-method-throws', 'thenable-rejects', 'never-resolves', 'reentrant'];
const observedComponents: ObservedComponent[] = ['CreateWalletUseCase', 'ProcessWagerTransactionUseCase', 'ReconcileWalletUseCase',
  'SqsWagerConsumer', 'OutboxPublisher', 'PendingReferenceWorker'];
for (const component of observedComponents) for (const mode of observerFailures) {
  test(`RED-C09 ${component} sends real metric observations and isolates ${mode}`, async () => {
    const events: MetricObservation[] = []; const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let resolveObserverCall: () => void = () => {};
      const observerCalled = new Promise<void>(resolve => { resolveObserverCall = resolve; });
      const observer = defectiveMetricsObserver(mode, events, () => resolveObserverCall());
      const operation = exerciseObservedComponent(component, observer);
      if (mode === 'never-resolves') {
        let settled = false; let operationError: unknown;
        const completion = operation.then(() => { settled = true; }, error => { settled = true; operationError = error; });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([completion, new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('RED-C09 operation exceeded 250ms with a pending observer')), 250);
          })]);
        } finally { clearTimeout(deadline); }
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(true);
        if (operationError !== undefined) throw operationError;
      } else {
        await operation;
      }
      expectMetricPath(component, events);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });
}

test('RED-C09 a throwing metrics observer cannot replace a definitive financial conflict', async () => {
  const h = financial(); const observed: MetricObservation[] = [];
  const observer: Observation = event => { observed.push(event); throw new Error('synthetic metrics observer fault'); };
  const processor = new ProcessWagerTransactionUseCase(h.uow,
    metricsOption(observer) as unknown as ConstructorParameters<typeof ProcessWagerTransactionUseCase>[1]);
  const first = await processor.execute(h.input);
  await expect(processor.execute({ ...h.input, money: { amount: '26.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(first.status).toBe(WagerTransactionStatus.Processed); expect(h.wallet.balance.toString()).toBe('75.00');
  expect(h.entries).toHaveLength(1); expect(h.outbox).toHaveLength(2);
  expect(observed.map(event => event.type)).toContain('wager-status');
  expect(observed.map(event => event.type)).toContain('duplicate');
  expect(observed.filter(event => event.type === 'processing-duration')).toHaveLength(2);
  expect(observed.filter(event => event.type === 'wager-status')).toEqual([{ type: 'wager-status', status: 'PROCESSED' }]);
});

test('RED-C10 CP-04, CP-05.A, CP-05.B and T21 contracts remain available beside /metrics', async () => {
  const h = financial('100.00'); h.store.ledgerTotal = async () => ({ amount: '95.00', count: 1 });
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reconciliation = new ReconcileWalletUseCase(h.uow); const result = await reconciliation.execute(h.wallet.id);
    expect(result.consistent).toBe(false); expect(reconciliation.divergenceObservations).toBe(1n); expect(warning).toHaveBeenCalledTimes(1);
    const app = await startHttp(h.uow); try {
      expect((await fetch(`${app.url}/health/live`)).status).toBe(200);
      expect((await fetch(`${app.url}/health/ready`)).status).toBe(503);
      const modules = [...app.app.get(ModulesContainer).values()];
      expect(modules.flatMap(module => [...module.providers.values()]).filter(provider => provider.metatype?.name === 'HttpExceptionFilter')).toHaveLength(1);
      expect((await metrics(app)).status).toBe(200);
    } finally { await app.close(); }
  } finally { warning.mockRestore(); }
});

test('RED-C12 separate HTTP graphs retain process-local snapshots and do not share state', async () => {
  const a = financial(); const b = financial();
  const appA = await startHttp(a.uow); const appB = await startHttp(b.uow);
  try {
    const committed = await appA.app.get(ProcessWagerTransactionUseCase).execute(a.input);
    expect(committed.status).toBe(WagerTransactionStatus.Processed); expect(a.entries).toHaveLength(1); expect(b.entries).toHaveLength(0);
    const responseA = await metrics(appA); expect(responseA.status).toBe(200); const snapshotA = await responseA.json() as typeof emptySnapshot;
    const responseB = await metrics(appB); expect(responseB.status).toBe(200); const snapshotB = await responseB.json() as typeof emptySnapshot;
    expect(snapshotA.scope).toBe('process'); expect(snapshotA.transactionsByStatus.PROCESSED).toBe(1);
    expect(snapshotB.scope).toBe('process'); expect(snapshotB.transactionsByStatus).toEqual(emptySnapshot.transactionsByStatus);
  } finally { await appA.close(); await appB.close(); }
});

test('RED-C13 each reconciliation adds one new observation while the legacy callback stays cumulative', async () => {
  const h = financial('100.00'); h.store.ledgerTotal = async () => ({ amount: '95.00', count: 1 });
  const legacy: bigint[] = []; const observe = capture(); const warning = spyOn(console, 'warn').mockImplementation(() => {});
  const options = { metric: (total: bigint) => legacy.push(total), operationalMetrics: observe.observe } as unknown as ConstructorParameters<typeof ReconcileWalletUseCase>[1];
  try {
    const reconcile = new ReconcileWalletUseCase(h.uow, options);
    for (let i = 0; i < 3; i++) expect((await reconcile.execute(h.wallet.id)).consistent).toBe(false);
    expect(reconcile.divergenceObservations).toBe(3n); expect(legacy).toEqual([1n, 2n, 3n]); expect(warning).toHaveBeenCalledTimes(3);
    expect(observe.values).toEqual([
      { type: 'reconciliation-divergence' },
      { type: 'reconciliation-divergence' },
      { type: 'reconciliation-divergence' },
    ]);
  } finally { warning.mockRestore(); }
});

type DynamicModuleShape = { readonly module?: unknown; readonly providers?: readonly unknown[]; readonly exports?: readonly unknown[]; readonly imports?: readonly unknown[] };
type FactoryProviderShape = { readonly provide?: unknown; readonly inject?: readonly unknown[]; readonly useFactory?: unknown };
const OPERATIONAL_METRICS_TOKEN = 'OPERATIONAL_METRICS';

function withMetadataDatabaseUrl<T>(inspect: () => T): T {
  const previous = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = 'postgresql://metadata-only:unused@127.0.0.1:1/jungle_test';
  try { return inspect(); }
  finally { if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous; }
}

function dynamicShape(value: unknown): DynamicModuleShape {
  if (!value || typeof value !== 'object') throw new Error('Expected DynamicModule metadata');
  return value as DynamicModuleShape;
}

function factoryProvider(module: DynamicModuleShape, token: unknown): FactoryProviderShape | undefined {
  return module.providers?.find(provider => !!provider && typeof provider === 'object'
    && (provider as FactoryProviderShape).provide === token) as FactoryProviderShape | undefined;
}

function importedModule(module: DynamicModuleShape, moduleClass: unknown): DynamicModuleShape | undefined {
  const value = module.imports?.find(candidate => !!candidate && typeof candidate === 'object'
    && (candidate as DynamicModuleShape).module === moduleClass);
  return value === undefined ? undefined : dynamicShape(value);
}

function metricsTokenFacts(module: DynamicModuleShape) {
  return {
    providerDeclared: factoryProvider(module, OPERATIONAL_METRICS_TOKEN) !== undefined,
    providerExported: module.exports?.includes(OPERATIONAL_METRICS_TOKEN) ?? false,
  };
}

function metricsDependencyDeclared(module: DynamicModuleShape, providerToken: unknown): boolean {
  const provider = factoryProvider(module, providerToken);
  return provider?.inject?.includes(OPERATIONAL_METRICS_TOKEN) ?? false;
}

test('RED-C14 metadata DatabaseModule.forRoot declares and injects its graph metrics token', () => {
  withMetadataDatabaseUrl(() => {
    const module = dynamicShape(DatabaseModule.forRoot());
    expect({ ...metricsTokenFacts(module),
      createWalletInjectsToken: metricsDependencyDeclared(module, CreateWalletUseCase),
      processWagerInjectsToken: metricsDependencyDeclared(module, ProcessWagerTransactionUseCase),
      reconciliationInjectsToken: metricsDependencyDeclared(module, ReconcileWalletUseCase),
    }).toEqual({ providerDeclared: true, providerExported: true, createWalletInjectsToken: true,
      processWagerInjectsToken: true, reconciliationInjectsToken: true });
  });
});

test('RED-C14 metadata MessagingModule.forConsumer imports and injects its graph metrics token', () => {
  withMetadataDatabaseUrl(() => {
    const module = dynamicShape(MessagingModule.forConsumer());
    const database = importedModule(module, DatabaseModule);
    expect({ importedDatabase: database !== undefined, ...(database ? metricsTokenFacts(database) : { providerDeclared: false, providerExported: false }),
      consumerInjectsToken: metricsDependencyDeclared(module, SqsWagerConsumer),
    }).toEqual({ importedDatabase: true, providerDeclared: true, providerExported: true, consumerInjectsToken: true });
  });
});

test('RED-C14 metadata MessagingModule.forPublisher imports and injects its graph metrics token', () => {
  withMetadataDatabaseUrl(() => {
    const module = dynamicShape(MessagingModule.forPublisher());
    const database = importedModule(module, DatabaseModule);
    expect({ importedDatabase: database !== undefined, ...(database ? metricsTokenFacts(database) : { providerDeclared: false, providerExported: false }),
      publisherInjectsToken: metricsDependencyDeclared(module, OutboxPublisher),
    }).toEqual({ importedDatabase: true, providerDeclared: true, providerExported: true, publisherInjectsToken: true });
  });
});

test('RED-C14 metadata WageringModule.forPendingReferences imports and injects its graph metrics token', () => {
  withMetadataDatabaseUrl(() => {
    const module = dynamicShape(WageringModule.forPendingReferences());
    const database = importedModule(module, DatabaseModule);
    expect({ importedDatabase: database !== undefined, ...(database ? metricsTokenFacts(database) : { providerDeclared: false, providerExported: false }),
      workerInjectsToken: metricsDependencyDeclared(module, PendingReferenceWorker),
    }).toEqual({ importedDatabase: true, providerDeclared: true, providerExported: true, workerInjectsToken: true });
  });
});

test('RED-C14 one operational metrics provider is shared inside a graph and distinct across graphs', async () => {
  const a = financial(); const b = financial(); const appA = await startHttp(a.uow); const appB = await startHttp(b.uow);
  const sharedIdentity = Object.freeze({
    observe: (_event: MetricObservation) => {},
    snapshot: () => structuredClone(emptySnapshot),
  });
  const appShared = await startHttp(a.uow, { metrics: sharedIdentity });
  const getMetricsProvider = (app: typeof appA): unknown => {
    try { return (app.app as unknown as { get(token: string): unknown }).get('OPERATIONAL_METRICS'); } catch { return undefined; }
  };
  try {
    const collectorA = getMetricsProvider(appA); const collectorB = getMetricsProvider(appB);
    const collectorShared = getMetricsProvider(appShared);
    expect({ graphAProvidesToken: collectorA !== undefined, graphBProvidesToken: collectorB !== undefined,
      independentGraphsAreDistinct: collectorA !== undefined && collectorB !== undefined && collectorA !== collectorB,
      explicitInstanceIsPreserved: collectorShared === sharedIdentity }).toEqual({ graphAProvidesToken: true, graphBProvidesToken: true,
      independentGraphsAreDistinct: true, explicitInstanceIsPreserved: true });
    if (collectorA === undefined) return; // Baseline RED; remaining assertions execute once the real provider exists.
    expect(getMetricsProvider(appA)).toBe(collectorA);
    const created = await appA.app.get(CreateWalletUseCase).execute({ playerId: 'metrics-di-player', initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId });
    expect(created.id).toBeString(); expect(a.calls).toContain('uow:commit');
    const committed = await appA.app.get(ProcessWagerTransactionUseCase).execute(a.input);
    expect(committed.status).toBe(WagerTransactionStatus.Processed);
    const responseA = await metrics(appA); const responseB = await metrics(appB);
    expect(responseA.status).toBe(200); expect(responseB.status).toBe(200);
    expect((await responseA.json() as typeof emptySnapshot).transactionsByStatus.PROCESSED).toBe(1);
    expect((await responseB.json() as typeof emptySnapshot).transactionsByStatus.PROCESSED).toBe(0);
  } finally { await appA.close(); await appB.close(); await appShared.close(); }
});

test('RED-C14 DatabaseModule.forHttp exposes one real metrics provider in its in-memory graph', async () => {
  const h = financial(); const context = await NestFactory.createApplicationContext(DatabaseModule.forHttp(h.uow), { logger: false, abortOnError: false });
  try {
    let first: unknown; let second: unknown;
    try { first = context.get('OPERATIONAL_METRICS'); second = context.get('OPERATIONAL_METRICS'); } catch { /* Missing token is the functional RED. */ }
    expect(first).toBeDefined(); expect(second).toBe(first);
  } finally { await context.close(); }
});

test('RED-C15 initial snapshot is entirely zeroed with no NaN, Infinity or null', async () => {
  const h = financial(); const app = await startHttp(h.uow);
  try { const response = await metrics(app); expect(response.status).toBe(200); const body = await response.json();
    expect(body).toEqual(emptySnapshot); expect(JSON.stringify(body)).not.toMatch(/NaN|Infinity|null/); }
  finally { await app.close(); }
});

test('RED-C16 metrics do not query financial storage or claim global Outbox/DLQ backlog', async () => {
  let calls = 0; const uow: FinancialUnitOfWork = { run: async () => { calls++; throw new Error('metrics must not query UoW'); } };
  const app = await startHttp(uow);
  try { const response = await metrics(app); expect(calls).toBe(0); expect(response.status).toBe(200); const body = await response.json() as typeof emptySnapshot;
    expect(body.scope).toBe('process'); expect(body.dlq).toEqual({ confirmedTransfers: 0 }); expect(body.outboxLagMs.count).toBe(0);
    expect(body).not.toHaveProperty('queueDepth'); expect(body).not.toHaveProperty('pendingOutboxCount'); }
  finally { await app.close(); }
});

test('RED-C01 schema fixture has the exact closed event and bucket inventory from the homologated plan', () => {
  expect(operationalEvents).toContain('reconciliation_divergence');
  expect(Object.keys(emptySnapshot)).toEqual(['scope', 'transactionsByStatus', 'duplicates', 'retries', 'dlq', 'concurrencyConflicts', 'outboxLagMs', 'processingDurationMs', 'reconciliation', 'pendingReference']);
  expect(Object.keys(emptySnapshot.transactionsByStatus)).toEqual(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED']);
  expect(Object.keys(bucketZero)).toEqual(['le5Ms', 'le10Ms', 'le25Ms', 'le50Ms', 'le100Ms', 'le250Ms', 'le500Ms', 'le1000Ms', 'gt1000Ms']);
});

test('GREEN-G1 collector starts with the exact zero snapshot and returns deeply frozen copies', () => {
  const collector = new DefaultOperationalMetricsCollector();
  const first = collector.snapshot();
  expect(first).toEqual(emptySnapshot as typeof first);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.transactionsByStatus)).toBe(true);
  expect(Object.isFrozen(first.outboxLagMs.buckets)).toBe(true);
  expect(Reflect.set(first.transactionsByStatus, 'PROCESSED', 99)).toBe(false);
  collector.observe({ type: 'wager-status', status: 'PROCESSED' });
  expect(first).toEqual(emptySnapshot as typeof first);
  expect(collector.snapshot().transactionsByStatus.PROCESSED).toBe(1);
});

test('GREEN-G1 collector maps all nine observation variants to the homologated snapshot', () => {
  const collector = new DefaultOperationalMetricsCollector();
  const observations: readonly OperationalMetricObservation[] = [
    { type: 'wager-status', status: 'PROCESSED' },
    { type: 'wager-status', status: 'REJECTED' },
    { type: 'wager-status', status: 'PENDING_REFERENCE' },
    { type: 'wager-status', status: 'FAILED' },
    { type: 'duplicate', kind: 'replay' },
    { type: 'duplicate', kind: 'conflict' },
    { type: 'retry-scheduled', target: 'wagerUow' },
    { type: 'retry-scheduled', target: 'walletUow' },
    { type: 'retry-scheduled', target: 'pendingReference' },
    { type: 'retry-scheduled', target: 'sqsConsumer' },
    { type: 'retry-scheduled', target: 'outboxPublisher' },
    { type: 'concurrency-conflict', code: '40P01' },
    { type: 'concurrency-conflict', code: '40001' },
    { type: 'concurrency-conflict', code: '55P03' },
    { type: 'concurrency-conflict', code: '57014' },
    { type: 'concurrency-conflict', code: '23505' },
    { type: 'dlq-transfer-confirmed' },
    { type: 'outbox-publication-confirmed', lagMs: 120 },
    { type: 'processing-duration', durationMs: 5 },
    { type: 'pending-reference-resolution', action: 'processed' },
    { type: 'pending-reference-resolution', action: 'rejected' },
    { type: 'pending-reference-resolution', action: 'rescheduled' },
    { type: 'reconciliation-divergence' },
  ];
  observations.forEach(observation => collector.observe(observation));
  const snapshot = collector.snapshot();
  expect(snapshot.transactionsByStatus).toEqual({ PROCESSED: 1, REJECTED: 1, PENDING_REFERENCE: 1, FAILED: 1 });
  expect(snapshot.duplicates).toEqual({ replays: 1, conflicts: 1 });
  expect(snapshot.retries).toEqual({ wagerUow: 1, walletUow: 1, pendingReference: 1, sqsConsumer: 1, outboxPublisher: 1 });
  expect(snapshot.concurrencyConflicts).toEqual({ total: 5, byCode: { '40P01': 1, '40001': 1, '55P03': 1, '57014': 1, '23505': 1 } });
  expect(snapshot.dlq).toEqual({ confirmedTransfers: 1 });
  expect(snapshot.outboxLagMs).toMatchObject({ count: 1, totalMs: 120, minMs: 120, maxMs: 120, lastMs: 120 });
  expect(snapshot.processingDurationMs).toMatchObject({ count: 1, totalMs: 5, minMs: 5, maxMs: 5, lastMs: 5 });
  expect(snapshot.pendingReference).toEqual({ processed: 1, rejected: 1, rescheduled: 1 });
  expect(snapshot.reconciliation).toEqual({ divergences: 1 });
});

const bucketBoundaries: readonly (readonly [number, keyof typeof bucketZero])[] = [
  [0, 'le5Ms'], [5, 'le5Ms'], [6, 'le10Ms'], [10, 'le10Ms'], [11, 'le25Ms'], [25, 'le25Ms'],
  [26, 'le50Ms'], [50, 'le50Ms'], [51, 'le100Ms'], [100, 'le100Ms'], [101, 'le250Ms'], [250, 'le250Ms'],
  [251, 'le500Ms'], [500, 'le500Ms'], [501, 'le1000Ms'], [1000, 'le1000Ms'], [1001, 'gt1000Ms'],
];

for (const [sampleMs, expectedBucket] of bucketBoundaries) {
  test(`GREEN-G1 outbox lag assigns ${sampleMs}ms to exactly ${expectedBucket}`, () => {
    const collector = new DefaultOperationalMetricsCollector();
    collector.observe({ type: 'outbox-publication-confirmed', lagMs: sampleMs });
    const aggregate = collector.snapshot().outboxLagMs;
    expect(aggregate.count).toBe(1);
    expect(aggregate.buckets[expectedBucket]).toBe(1);
    expect(Object.values(aggregate.buckets).reduce((sum, value) => sum + value, 0)).toBe(aggregate.count);
  });

  test(`GREEN-G1 processing duration assigns ${sampleMs}ms to exactly ${expectedBucket}`, () => {
    const collector = new DefaultOperationalMetricsCollector();
    collector.observe({ type: 'processing-duration', durationMs: sampleMs });
    const aggregate = collector.snapshot().processingDurationMs;
    expect(aggregate.count).toBe(1);
    expect(aggregate.buckets[expectedBucket]).toBe(1);
    expect(Object.values(aggregate.buckets).reduce((sum, value) => sum + value, 0)).toBe(aggregate.count);
  });
}

test('GREEN-G1 ignores malformed, out-of-catalog and invalid temporal observations atomically', () => {
  const collector = new DefaultOperationalMetricsCollector();
  const getter = Object.defineProperty({}, 'type', { enumerable: true, get() { throw new Error('must not evaluate'); } });
  const symbolKey = { type: 'dlq-transfer-confirmed', [Symbol('extra')]: true };
  const invalid: unknown[] = [
    null, undefined, 3, 'event', [], {}, { type: 'unknown-event' },
    { type: 'wager-status', status: 'UNKNOWN' }, { type: 'wager-status', status: 'PROCESSED', extra: true },
    { type: 'duplicate', kind: 'other' }, { type: 'retry-scheduled', target: 'arbitrary' },
    { type: 'concurrency-conflict', code: '23505', constraint: 'dynamic-label' },
    { type: 'outbox-publication-confirmed', lagMs: -1 }, { type: 'outbox-publication-confirmed', lagMs: Number.NaN },
    { type: 'outbox-publication-confirmed', lagMs: Number.POSITIVE_INFINITY },
    { type: 'outbox-publication-confirmed', lagMs: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'outbox-publication-confirmed', lagMs: Number.MAX_VALUE },
    { type: 'processing-duration', durationMs: Number.NEGATIVE_INFINITY },
    { type: 'processing-duration', durationMs: -0.01 }, { type: 'pending-reference-resolution', action: 'noop' },
    { type: 'processing-duration', durationMs: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'processing-duration', durationMs: Number.MAX_VALUE },
    { type: 'reconciliation-divergence', value: 1 }, getter, symbolKey,
  ];
  const before = collector.snapshot();
  for (const observation of invalid) collector.observe(observation as OperationalMetricObservation);
  expect(collector.snapshot()).toEqual(before);
  collector.observe({ type: 'outbox-publication-confirmed', lagMs: 5 });
  collector.observe({ type: 'processing-duration', durationMs: 6 });
  const afterValid = collector.snapshot();
  expect(afterValid.outboxLagMs).toMatchObject({ count: 1, minMs: 5, maxMs: 5, lastMs: 5, totalMs: 5 });
  expect(afterValid.processingDurationMs).toMatchObject({ count: 1, minMs: 6, maxMs: 6, lastMs: 6, totalMs: 6 });
  expect(afterValid.outboxLagMs.maxMs).toBeLessThanOrEqual(afterValid.outboxLagMs.totalMs);
  expect(afterValid.processingDurationMs.maxMs).toBeLessThanOrEqual(afterValid.processingDurationMs.totalMs);
});

test('GREEN-G1 pure counter reducer saturates safely and rejects invalid state', () => {
  expect(reduceSaturatedCounter(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(reduceSaturatedCounter(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  expect(reduceSaturatedCounter(-1)).toBeUndefined();
  expect(reduceSaturatedCounter(1.5)).toBeUndefined();
  expect(reduceSaturatedCounter(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
});

test('GREEN-G1 temporal reducer saturates totalMs while atomically advancing count and one bucket', () => {
  const current: OperationalMetricsTimeAggregate = {
    count: 2,
    totalMs: Number.MAX_SAFE_INTEGER - 2,
    minMs: 5,
    maxMs: 10,
    lastMs: 10,
    buckets: { ...bucketZero, le5Ms: 1, le10Ms: 1 },
  };
  const next = reduceTimeAggregate(current, 7)!;
  expect(next).toEqual({ count: 3, totalMs: Number.MAX_SAFE_INTEGER, minMs: 5, maxMs: 10, lastMs: 7,
    buckets: { ...bucketZero, le5Ms: 1, le10Ms: 2 } });
  expect(current).toEqual({ count: 2, totalMs: Number.MAX_SAFE_INTEGER - 2, minMs: 5, maxMs: 10, lastMs: 10,
    buckets: { ...bucketZero, le5Ms: 1, le10Ms: 1 } });
});

test('GREEN-G1 collector.observe saturates totalMs for both aggregates while retaining samples and buckets', () => {
  const collector = new DefaultOperationalMetricsCollector();
  collector.observe({ type: 'outbox-publication-confirmed', lagMs: Number.MAX_SAFE_INTEGER });
  collector.observe({ type: 'outbox-publication-confirmed', lagMs: 1 });
  collector.observe({ type: 'processing-duration', durationMs: Number.MAX_SAFE_INTEGER });
  collector.observe({ type: 'processing-duration', durationMs: 1 });
  const snapshot = collector.snapshot();
  for (const aggregate of [snapshot.outboxLagMs, snapshot.processingDurationMs]) {
    expect(aggregate.totalMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(aggregate.count).toBe(2);
    expect(aggregate.buckets.gt1000Ms).toBe(1);
    expect(aggregate.buckets.le5Ms).toBe(1);
    expect(Object.values(aggregate.buckets).reduce((sum, value) => sum + value, 0)).toBe(aggregate.count);
    expect(aggregate.minMs).toBe(1);
    expect(aggregate.maxMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(aggregate.lastMs).toBe(1);
    expect(aggregate.maxMs).toBeLessThanOrEqual(aggregate.totalMs);
  }
});

test('GREEN-G1 temporal reducer rejects a saturated count without partial mutation', () => {
  const current: OperationalMetricsTimeAggregate = {
    count: Number.MAX_SAFE_INTEGER,
    totalMs: Number.MAX_SAFE_INTEGER,
    minMs: 1001,
    maxMs: 1001,
    lastMs: 1001,
    buckets: { ...bucketZero, gt1000Ms: Number.MAX_SAFE_INTEGER },
  };
  const before = structuredClone(current);
  expect(reduceTimeAggregate(current, 5)).toBeUndefined();
  expect(current).toEqual(before);
});

test('GREEN-G1 temporal reducer rejects invalid samples without changing its input', () => {
  const collector = new DefaultOperationalMetricsCollector();
  collector.observe({ type: 'processing-duration', durationMs: 10 });
  const current = collector.snapshot().processingDurationMs;
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, '5' as unknown as number]) {
    expect(reduceTimeAggregate(current, invalid)).toBeUndefined();
  }
  expect(current).toEqual(collector.snapshot().processingDurationMs);
});

test('GREEN-G1 concurrency total remains the sum of fixed SQLSTATE counters', () => {
  const collector = new DefaultOperationalMetricsCollector();
  const codes = ['40P01', '40001', '55P03', '57014', '23505'] as const;
  for (const code of codes) {
    collector.observe({ type: 'concurrency-conflict', code });
    collector.observe({ type: 'concurrency-conflict', code });
  }
  const conflicts = collector.snapshot().concurrencyConflicts;
  expect(conflicts.total).toBe(10);
  expect(Object.values(conflicts.byCode).reduce((sum, value) => sum + value, 0)).toBe(conflicts.total);
});

test('GREEN-G1 concurrency reducer saturates through MAX_SAFE_INTEGER without breaking the total invariant', () => {
  let current = {
    total: Number.MAX_SAFE_INTEGER - 1,
    byCode: { '40P01': Number.MAX_SAFE_INTEGER - 1, '40001': 0, '55P03': 0, '57014': 0, '23505': 0 },
  };
  current = reduceConcurrencyConflict(current, '40P01')!;
  expect(current.total).toBe(Number.MAX_SAFE_INTEGER);
  expect(current.byCode['40P01']).toBe(Number.MAX_SAFE_INTEGER);
  expect(Object.values(current.byCode).reduce((sum, value) => sum + value, 0)).toBe(current.total);
  current = reduceConcurrencyConflict(current, '40P01')!;
  expect(current.total).toBe(Number.MAX_SAFE_INTEGER);
  expect(current.byCode['40P01']).toBe(Number.MAX_SAFE_INTEGER);
  expect(Object.values(current.byCode).reduce((sum, value) => sum + value, 0)).toBe(current.total);
});

test('GREEN-G1 temporal reducer rejects malformed bucket state before constructing an update', () => {
  const valid: OperationalMetricsTimeAggregate = {
    count: 2, totalMs: 10, minMs: 5, maxMs: 5, lastMs: 5,
    buckets: { ...bucketZero, le5Ms: 2 },
  };
  const invalidBuckets = [
    { ...bucketZero, le5Ms: -1, le10Ms: 3 },
    { ...bucketZero, le5Ms: 0.5, le10Ms: 1.5 },
    { ...bucketZero, le5Ms: Number.MAX_SAFE_INTEGER + 1, le10Ms: -Number.MAX_SAFE_INTEGER + 1 },
    { ...bucketZero, le5Ms: 1 },
  ];
  for (const buckets of invalidBuckets) {
    const current = { ...valid, buckets } as OperationalMetricsTimeAggregate;
    const before = structuredClone(current);
    expect(reduceTimeAggregate(current, 6)).toBeUndefined();
    expect(current).toEqual(before);
  }
});

test('GREEN-G1 collector instances keep independent process-local snapshots', () => {
  const first = new DefaultOperationalMetricsCollector();
  const second = new DefaultOperationalMetricsCollector();
  first.observe({ type: 'reconciliation-divergence' });
  expect(first.snapshot().reconciliation.divergences).toBe(1);
  expect(second.snapshot().reconciliation.divergences).toBe(0);
});

// GREEN-G2 additions. Namespace lookup keeps the functional missing-export RED compilable.
import * as g2MetricsModule from '../../src/shared/application/operational-metrics';
import type { OperationalMetricsInput } from '../../src/shared/application/operational-metrics';

type G2EmitterFactory = (input?: OperationalMetricsInput) => (event: OperationalMetricObservation) => void;
function g2Factory(): G2EmitterFactory {
  const candidate: unknown = (g2MetricsModule as unknown as Record<string, unknown>)['operationalMetricsEmitter'];
  expect(typeof candidate).toBe('function');
  return candidate as G2EmitterFactory;
}
const g2First: OperationalMetricObservation = { type: 'duplicate', kind: 'replay' };
const g2Second: OperationalMetricObservation = { type: 'duplicate', kind: 'conflict' };

async function g2WithoutUnhandled(work: () => void): Promise<void> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    work();
    // The fixtures reject during work; two host turns also cover native reaction jobs.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', listener); }
}

test('GREEN-G2 T01 absent and runtime-invalid inputs are stable no-ops', () => {
  const factory = g2Factory();
  for (const input of [undefined, null, 0, 'invalid', {}, { observe: 1 }] as unknown[]) {
    const emit = factory(input as OperationalMetricsInput | undefined);
    expect(emit(g2First)).toBeUndefined();
    expect(emit(g2Second)).toBeUndefined();
  }
});

test('GREEN-G2 T02 callback receives the original event synchronously', () => {
  const received: OperationalMetricObservation[] = [];
  const emit = g2Factory()(event => { received.push(event); });
  expect(emit(g2First)).toBeUndefined();
  expect(received).toHaveLength(1);
  expect(received[0]).toBe(g2First);
});

test('GREEN-G2 T03 object receiver and real collector are preserved', () => {
  const factory = g2Factory();
  const object = { events: [] as OperationalMetricObservation[], observe(event: OperationalMetricObservation) { this.events.push(event); } };
  factory(object)(g2First);
  expect(object.events[0]).toBe(g2First);
  const collector = new DefaultOperationalMetricsCollector();
  factory(collector)(g2First);
  expect(collector.snapshot().duplicates).toEqual({ replays: 1, conflicts: 0 });
});

test('GREEN-G2 T04 synchronous throws release the guard for subsequent emissions', () => {
  const received: OperationalMetricObservation[] = [];
  const emit = g2Factory()(event => { received.push(event); throw new Error('G2 sync fault'); });
  expect(emit(g2First)).toBeUndefined();
  expect(emit(g2Second)).toBeUndefined();
  expect(received).toEqual([g2First, g2Second]);
});

for (const mode of ['async-reject', 'already-rejected'] as const) {
  test(`GREEN-G2 T05 consumes ${mode} without awaiting the observer`, async () => {
    const factory = g2Factory(); let calls = 0;
    await g2WithoutUnhandled(() => {
      const rejected = Promise.reject(new Error('G2 immediate rejection'));
      const observer = mode === 'async-reject'
        ? async () => { calls++; throw new Error('G2 async rejection'); }
        : () => { calls++; return rejected; };
      // Both fixtures' rejected Promises must be owned by this test's observer path.
      if (mode === 'async-reject') factory(() => rejected)(g2First);
      expect(factory(observer)(g2First)).toBeUndefined();
      expect(calls).toBe(1);
    });
  });
}

test('GREEN-G2 T06 contains an accessed throwing then getter', async () => {
  const factory = g2Factory(); let reads = 0; let calls = 0;
  await g2WithoutUnhandled(() => {
    const emit = factory(() => { calls++; return Object.defineProperty({}, 'then', { get() { reads++; throw new Error('G2 then getter'); } }); });
    expect(emit(g2First)).toBeUndefined(); expect(emit(g2Second)).toBeUndefined();
    expect(calls).toBe(2); expect(reads).toBe(2);
  });
});

test('GREEN-G2 T07 contains an invoked throwing then method with its receiver', async () => {
  const factory = g2Factory(); let calls = 0;
  const result = { then() { expect(this).toBe(result); calls++; throw new Error('G2 then method'); } };
  await g2WithoutUnhandled(() => { expect(factory(() => result)(g2First)).toBeUndefined(); });
  expect(calls).toBe(1);
});

for (const mode of ['reject', 'resolve-reject', 'resolve-throw', 'return-promise', 'resolve-promise', 'reject-promise'] as const) {
  test(`GREEN-G2 T08 contains custom thenable ${mode}`, async () => {
    const factory = g2Factory(); let calls = 0;
    await g2WithoutUnhandled(() => {
      const result = { then(resolve: (value: unknown) => void, reject: (value: unknown) => void) {
        expect(this).toBe(result); calls++;
        if (mode === 'return-promise') return Promise.reject(new Error('G2 returned Promise'));
        if (mode === 'resolve-promise') { resolve(Promise.reject(new Error('G2 resolved Promise'))); return; }
        if (mode === 'reject-promise') { reject(Promise.reject(new Error('G2 rejected Promise value'))); return; }
        if (mode !== 'reject') resolve(undefined);
        if (mode === 'resolve-throw') throw new Error('G2 post-resolution throw');
        reject(new Error('G2 thenable rejection'));
      } };
      expect(factory(() => result)(g2First)).toBeUndefined();
      expect(calls).toBe(1);
    });
  });
}

for (const mode of ['pending-promise', 'pending-thenable', 'self-reference'] as const) {
  test(`GREEN-G2 T09 ${mode} returns immediately and leaves the event loop free`, async () => {
    const factory = g2Factory(); let calls = 0; let thenCalls = 0;
    const result = mode === 'pending-promise' ? new Promise<void>(() => {}) : {
      then(resolve: (value: unknown) => void) {
        thenCalls++;
        // A broken recursive assimilator fails finitely instead of hanging the runner.
        if (thenCalls > 4) throw new Error('G2 bounded self-reference fixture');
        if (mode === 'self-reference') resolve(result);
      },
    };
    const emit = factory(() => { calls++; return result; });
    expect(emit(g2First)).toBeUndefined(); expect(calls).toBe(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(thenCalls).toBe(mode === 'pending-promise' ? 0 : 1);
  });
}

for (const mode of ['same-callback', 'second-adapter', 'object', 'getter', 'then-method'] as const) {
  test(`GREEN-G2 T10 contains synchronous reentry through ${mode}`, () => {
    const factory = g2Factory(); let calls = 0; let reads = 0; let thenCalls = 0;
    let nested: (event: OperationalMetricObservation) => void = () => {};
    const callback = () => {
      calls++;
      if (calls < 4 && mode !== 'then-method') nested(g2Second);
      if (mode === 'then-method') return { then() { thenCalls++; if (thenCalls < 4) nested(g2Second); } };
    };
    const object = { observe: callback };
    const input = mode === 'getter' ? Object.defineProperty({}, 'observe', { get() {
      reads++; if (reads < 4) nested(g2Second); return callback;
    } }) as OperationalMetricsInput : mode === 'object' ? object : callback;
    const emit = factory(input);
    nested = mode === 'second-adapter' ? factory(input) : emit;
    emit(g2First);
    expect(calls).toBe(1);
    expect(reads).toBe(mode === 'getter' ? 1 : 0);
    expect(thenCalls).toBe(mode === 'then-method' ? 1 : 0);
    emit(g2First);
    expect(calls).toBe(2);
  });
}

test('GREEN-G2 T11 consecutive observations retain order and distinct inputs remain independent', () => {
  const factory = g2Factory(); const received: OperationalMetricObservation[] = [];
  const emit = factory(event => { received.push(event); return {}; });
  emit(g2First); emit(g2Second);
  expect(received).toEqual([g2First, g2Second]);
  const a = new DefaultOperationalMetricsCollector(); const b = new DefaultOperationalMetricsCollector();
  expect(a.observe).toBe(b.observe);
  const emitB = factory(b);
  const original = a.observe;
  a.observe = function(event) { original.call(this, event); emitB(g2Second); };
  factory(a)(g2First);
  expect(a.snapshot().duplicates).toEqual({ replays: 1, conflicts: 0 });
  expect(b.snapshot().duplicates).toEqual({ replays: 0, conflicts: 1 });
  let nestedCalls = 0;
  const other = factory(() => { nestedCalls++; });
  factory(() => { other(g2First); })(g2First);
  expect(nestedCalls).toBe(1);
});

test('GREEN-G2 T11 distinct objects sharing the exact observe method do not collide', () => {
  const factory = g2Factory();
  class Observer {
    calls = 0;
    nested: (() => void) | undefined;
    observe() { this.calls++; this.nested?.(); }
  }
  const a = new Observer(); const b = new Observer();
  expect(a.observe).toBe(b.observe);
  const emitB = factory(b); a.nested = () => emitB(g2Second);
  factory(a)(g2First);
  expect(a.calls).toBe(1); expect(b.calls).toBe(1);
});

test('GREEN-G2 T12 observe getter is lazy, reentrant faults are contained and the guard releases', () => {
  const factory = g2Factory(); let reads = 0;
  let emit: (event: OperationalMetricObservation) => void = () => {};
  const input = Object.defineProperty({}, 'observe', { get() {
    reads++; if (reads < 4) emit(g2Second); throw new Error('G2 observe getter');
  } }) as OperationalMetricsInput;
  emit = factory(input); expect(reads).toBe(0);
  expect(emit(g2First)).toBeUndefined(); expect(reads).toBe(1);
  expect(emit(g2Second)).toBeUndefined(); expect(reads).toBe(2);
});

test('GREEN-G2 T13 an earlier pending Promise does not suppress the next immediate observation', () => {
  const received: OperationalMetricObservation[] = [];
  const pending = new Promise<void>(() => {});
  const emit = g2Factory()(event => { received.push(event); return pending; });
  expect(emit(g2First)).toBeUndefined(); expect(emit(g2Second)).toBeUndefined();
  expect(received).toHaveLength(2);
  expect(received[0]).toBe(g2First); expect(received[1]).toBe(g2Second);
});

for (const mode of ['getter', 'method'] as const) {
  test(`GREEN-G2 T14 native rejection bypasses hostile own then ${mode}`, async () => {
    const factory = g2Factory(); let hostileCalls = 0; let observerCalls = 0;
    await g2WithoutUnhandled(() => {
      const rejected = Promise.reject(new Error('G2 native rejection'));
      const hostile = () => { hostileCalls++; throw new Error('G2 hostile own then'); };
      Object.defineProperty(rejected, 'then', mode === 'getter' ? { get: hostile } : { value: hostile });
      const emit = factory(() => { observerCalls++; return rejected; });
      expect(emit(g2First)).toBeUndefined(); expect(emit(g2Second)).toBeUndefined();
      expect(observerCalls).toBe(2); expect(hostileCalls).toBe(0);
    });
    expect(hostileCalls).toBe(0);
  });
}

test('GREEN-G2 T15 repeated pending Promise receives one intrinsic reaction across adapters', () => {
  const factory = g2Factory(); let reactions = 0; let observerCalls = 0;
  class Pending extends Promise<void> {
    static override get [Symbol.species]() { reactions++; return Promise; }
  }
  const pending = new Pending(() => {});
  const observer = () => { observerCalls++; return pending; };
  const a = factory(observer); const b = factory(observer);
  for (let index = 0; index < 10; index++) { a(g2First); b(g2Second); }
  expect(observerCalls).toBe(20);
  expect(reactions).toBe(1);
});

// GREEN-G3 additions: exercise baseline modules without importing a future controller.
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM as G3CoreORM } from '@mikro-orm/core';
import { MikroORM as G3PostgresORM } from '@mikro-orm/postgresql';
import { SQSClient as G3SqsClient } from '@aws-sdk/client-sqs';
import { FINANCIAL_UNIT_OF_WORK } from '../../src/shared/application/financial-store';
import type { OperationalMetricsCollector } from '../../src/shared/application/operational-metrics';
import { HttpExceptionFilter as G3HttpExceptionFilter } from '../../src/shared/infrastructure/http-exception.filter';
import { ProviderIdentityGuard as G3ProviderGuard } from '../../src/shared/infrastructure/provider-identity.guard';
import { PostgresHealthProbe as G3PostgresProbe } from '../../src/shared/infrastructure/postgres-health.probe';

type G3CompositionOptions = { readonly metrics?: OperationalMetricsCollector | undefined };
// These boundaries now use the real additive signatures validated by the typecheck.
const g3ForHttp = (uow: FinancialUnitOfWork, options?: G3CompositionOptions): DynamicModule =>
  DatabaseModule.forHttp(uow, options);
const g3ForRoot = (options?: G3CompositionOptions): DynamicModule =>
  DatabaseModule.forRoot(options);
const g3NoWork: FinancialUnitOfWork = { async run() { throw new Error('G3 must not access the financial UoW'); } };

function g3MetricsFactory(module: DynamicModule): () => OperationalMetricsCollector {
  const provider = factoryProvider(dynamicShape(module), OPERATIONAL_METRICS_TOKEN);
  expect(provider).toBeDefined();
  expect(module.exports).toContain(OPERATIONAL_METRICS_TOKEN);
  expect(provider?.inject ?? []).toEqual([]);
  expect(typeof provider?.useFactory).toBe('function');
  return provider!.useFactory as () => OperationalMetricsCollector;
}

function g3ContextFacts(app: { get(token: typeof ModulesContainer): ModulesContainer }) {
  const modules = [...app.get(ModulesContainer).values()];
  return {
    databases: modules.filter(module => module.metatype === DatabaseModule),
    metricsProviders: modules.flatMap(module => [...module.providers.entries()])
      .filter(([token]) => token === OPERATIONAL_METRICS_TOKEN).map(([, provider]) => provider.instance),
    ormProviders: modules.flatMap(module => [...module.providers.keys()]).filter(token => token === G3CoreORM),
    workers: modules.flatMap(module => [...module.providers.values()])
      .filter(provider => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(provider.metatype?.name ?? '')),
    filters: modules.flatMap(module => [...module.providers.values()])
      .filter(provider => provider.metatype === G3HttpExceptionFilter),
  };
}

test('GREEN-G3 T01 metrics returns exact local JSON and a correlation ID', async () => {
  const h = await startHttp(g3NoWork);
  try {
    const response = await metrics(h);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(await response.json()).toEqual(emptySnapshot);
  } finally { await h.close(); }
});

for (const query of ['?x=1', '?x=', '?x=1&x=2', '?x[]=1']) {
  test(`GREEN-G3 T02 rejects query ${query} before reading a snapshot`, async () => {
    let snapshotCalls = 0;
    const collector: OperationalMetricsCollector = {
      observe() {}, snapshot() { snapshotCalls++; return new DefaultOperationalMetricsCollector().snapshot(); },
    };
    const h = await startHttp(g3NoWork, { metrics: collector });
    try {
      const response = await fetch(`${h.url}/metrics${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'INVALID_INPUT', message: 'Invalid input' });
      expect(snapshotCalls).toBe(0);
    } finally { await h.close(); }
  });
}

test('GREEN-G3 T03 same forHttp descriptor creates independent context-local collectors', async () => {
  const database = g3ForHttp(g3NoWork);
  g3MetricsFactory(database);
  const a = await NestFactory.createApplicationContext(database, { logger: false, abortOnError: false });
  let b: typeof a | undefined;
  try {
    b = await NestFactory.createApplicationContext(database, { logger: false, abortOnError: false });
    const first = a.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN);
    const second = b.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN);
    expect(a.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN)).toBe(first);
    expect(first).toBeInstanceOf(DefaultOperationalMetricsCollector);
    expect(second).toBeInstanceOf(DefaultOperationalMetricsCollector);
    expect(first).not.toBe(second);
    first.observe(g2First);
    expect(first.snapshot().duplicates.replays).toBe(1);
    expect(second.snapshot().duplicates.replays).toBe(0);
    for (const context of [a, b]) {
      const facts = g3ContextFacts(context);
      expect(facts.databases).toHaveLength(1); expect(facts.metricsProviders).toHaveLength(1);
      expect(facts.ormProviders).toEqual([]); expect(facts.workers).toEqual([]);
    }
  } finally { await b?.close(); await a.close(); }
});

test('GREEN-G3 T04 forRoot factory is lazy, independent and preserves explicit identity without PostgreSQL boot', () => {
  withMetadataDatabaseUrl(() => {
    const defaults = g3ForRoot();
    const factory = g3MetricsFactory(defaults);
    const a = factory(); const b = factory();
    expect(a).toBeInstanceOf(DefaultOperationalMetricsCollector);
    expect(b).toBeInstanceOf(DefaultOperationalMetricsCollector);
    expect(a).not.toBe(b); expect(a.snapshot()).toEqual(emptySnapshot as ReturnType<OperationalMetricsCollector['snapshot']>);
    const explicit = new DefaultOperationalMetricsCollector();
    const explicitFactory = g3MetricsFactory(g3ForRoot({ metrics: explicit }));
    expect(explicitFactory()).toBe(explicit); expect(explicitFactory()).toBe(explicit);
    expect(g3MetricsFactory(g3ForRoot({ metrics: undefined }))()).toBeInstanceOf(DefaultOperationalMetricsCollector);
    const work = factoryProvider(dynamicShape(defaults), FINANCIAL_UNIT_OF_WORK);
    expect(work?.inject).toEqual([G3CoreORM]);
    for (const token of [CreateWalletUseCase, ProcessWagerTransactionUseCase, ReconcileWalletUseCase]) {
      expect(factoryProvider(dynamicShape(defaults), token)?.inject).toEqual([FINANCIAL_UNIT_OF_WORK, OPERATIONAL_METRICS_TOKEN]);
      expect(defaults.exports).toContain(token);
    }
    expect(defaults.imports).toHaveLength(1);
  });
});

test('GREEN-G3 T05 HTTP graphs expose only their own directly observed state', async () => {
  const a = await startHttp(g3NoWork); const b = await startHttp(g3NoWork);
  try {
    const first = a.app.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN);
    const second = b.app.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN);
    expect(first).not.toBe(second);
    first.observe(g2First);
    const responseA = await metrics(a); const responseB = await metrics(b);
    expect(responseA.status).toBe(200); expect(responseB.status).toBe(200);
    expect((await responseA.json() as typeof emptySnapshot).duplicates).toEqual({ replays: 1, conflicts: 0 });
    expect(await responseB.json()).toEqual(emptySnapshot);
  } finally { await b.close(); await a.close(); }
});

test('GREEN-G3 T06 explicit collector identity is shared unchanged across HTTP graphs and forHttp factory', async () => {
  const collector = new DefaultOperationalMetricsCollector();
  expect(g3MetricsFactory(g3ForHttp(g3NoWork, { metrics: collector }))()).toBe(collector);
  const a = await startHttp(g3NoWork, { metrics: collector }); const b = await startHttp(g3NoWork, { metrics: collector });
  try {
    expect(a.app.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN)).toBe(collector);
    expect(b.app.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN)).toBe(collector);
    collector.observe(g2Second);
    for (const graph of [a, b]) {
      const response = await metrics(graph); expect(response.status).toBe(200);
      expect(await response.json()).toEqual(collector.snapshot());
      expect(g3ContextFacts(graph.app).metricsProviders).toEqual([collector]);
    }
  } finally { await b.close(); await a.close(); }
});

test('GREEN-G3 T07 four HTTP modules reuse one database descriptor and one actual provider', async () => {
  const compose = spyOn(DatabaseModule, 'forHttp');
  let root: ReturnType<typeof AppModule.register>;
  try {
    root = AppModule.register({ uow: g3NoWork });
    expect(compose).toHaveBeenCalledTimes(1);
    const database = compose.mock.results[0]!.value as DynamicModule;
    const imports = root.imports as DynamicModule[];
    expect(imports.map(module => module.module.name)).toEqual(['WalletsModule', 'WageringModule', 'HealthHttpModule', 'MetricsHttpModule']);
    for (const module of imports) {
      expect(module.imports).toHaveLength(1);
      expect(module.imports![0]).toBe(database);
      expect(factoryProvider(dynamicShape(module), OPERATIONAL_METRICS_TOKEN)).toBeUndefined();
    }
  } finally { compose.mockRestore(); }
  const app = await NestFactory.create(root!, { logger: false, abortOnError: false });
  try {
    const facts = g3ContextFacts(app);
    expect(facts.databases).toHaveLength(1); expect(facts.metricsProviders).toHaveLength(1);
    expect(facts.metricsProviders[0]).toBe(app.get(OPERATIONAL_METRICS_TOKEN));
  } finally { await app.close(); }
});

test('GREEN-G3 T08 metrics bootstrap and handler have no financial, ORM, SQS, health or guard effects', async () => {
  let workCalls = 0; let probeCalls = 0;
  const uow: FinancialUnitOfWork = { async run() { workCalls++; throw new Error('G3 forbidden UoW'); } };
  const probe = async () => { probeCalls++; throw new Error('G3 forbidden readiness probe'); };
  const init = spyOn(G3PostgresORM, 'init').mockImplementation(() => { throw new Error('G3 forbidden ORM initialization'); });
  const send = spyOn(G3SqsClient.prototype, 'send').mockImplementation(() => { throw new Error('G3 forbidden SQS send'); });
  const postgres = spyOn(G3PostgresProbe.prototype, 'check').mockImplementation(() => { throw new Error('G3 forbidden PostgreSQL probe'); });
  const guard = spyOn(G3ProviderGuard.prototype, 'canActivate').mockReturnValue(false);
  let h: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    h = await startHttp(uow, { health: { postgres: probe, sqs: probe } });
    const response = await metrics(h);
    expect(workCalls).toBe(0); expect(probeCalls).toBe(0);
    expect(init).toHaveBeenCalledTimes(0); expect(send).toHaveBeenCalledTimes(0);
    expect(postgres).toHaveBeenCalledTimes(0); expect(guard).toHaveBeenCalledTimes(0);
    const facts = g3ContextFacts(h.app);
    expect(facts.ormProviders).toEqual([]); expect(facts.workers).toEqual([]);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(emptySnapshot);
  } finally {
    try { await h?.close(); }
    finally { guard.mockRestore(); postgres.mockRestore(); send.mockRestore(); init.mockRestore(); }
  }
});

test('GREEN-G3 T09 legacy composition, controlled health probes and the original T21 filter coexist', async () => {
  const legacyDatabase = DatabaseModule.forHttp(g3NoWork);
  expect(legacyDatabase.exports).toContain(FINANCIAL_UNIT_OF_WORK);
  expect(g3MetricsFactory(g3ForHttp(g3NoWork, { metrics: undefined }))()).toBeInstanceOf(DefaultOperationalMetricsCollector);
  let postgresCalls = 0; let sqsCalls = 0;
  const root = requestOptions(g3NoWork, { health: {
    postgres: async () => { postgresCalls++; }, sqs: async () => { sqsCalls++; },
  } });
  const providers = Reflect.getMetadata('providers', root.module) as { provide: unknown; useClass?: unknown }[];
  expect(providers.filter(provider => provider.provide === APP_FILTER)).toHaveLength(1);
  expect(providers.find(provider => provider.provide === APP_FILTER)?.useClass).toBe(G3HttpExceptionFilter);
  const app = await NestFactory.create(root, { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1'); const url = await app.getUrl();
    const live = await fetch(`${url}/health/live`);
    expect(live.status).toBe(200); expect(await live.json()).toEqual({ status: 'ok' });
    expect(postgresCalls).toBe(0); expect(sqsCalls).toBe(0);
    const ready = await fetch(`${url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', dependencies: { postgres: 'up', sqs: 'up' } });
    expect(postgresCalls).toBe(1); expect(sqsCalls).toBe(1);
    expect(g3ContextFacts(app).filters).toHaveLength(1);
    expect((await fetch(`${url}/metrics`)).status).toBe(200);
  } finally { await app.close(); }
});

// GREEN-G4 additions. Unit UoW fixtures establish observation boundaries, not PostgreSQL rollback guarantees.
import { operationalMetricsEmitter as g4Emitter, type OperationalMetricsOptions } from '../../src/shared/application/operational-metrics';
import { NotFoundError as G4NotFoundError, PersistenceInvariantError as G4PersistenceError } from '../../src/shared/application/application-errors';
import { GetWalletUseCase as G4GetWallet, ListWalletLedgerUseCase as G4ListLedger } from '../../src/modules/wallets/application/wallet-queries';
import { GetWagerTransactionUseCase as G4GetWager } from '../../src/modules/wagering/application/get-wager-transaction.use-case';

function g4Process(uow: FinancialUnitOfWork, operationalMetrics?: OperationalMetricsInput,
  extras: ConstructorParameters<typeof ProcessWagerTransactionUseCase>[1] = {}) {
  const options: NonNullable<typeof extras> & OperationalMetricsOptions = { now: () => at, ...extras, operationalMetrics };
  return new ProcessWagerTransactionUseCase(uow, options);
}
function g4Wallet(uow: FinancialUnitOfWork, operationalMetrics?: OperationalMetricsInput,
  extras: ConstructorParameters<typeof CreateWalletUseCase>[1] = {}) {
  const options: NonNullable<typeof extras> & OperationalMetricsOptions = { now: () => at, ...extras, operationalMetrics };
  return new CreateWalletUseCase(uow, options);
}
function g4Open(useCase: CreateWalletUseCase) {
  return useCase.execute({ playerId: 'g4-player', initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId });
}
function g4Deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function g4Deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('GREEN-G4 operation exceeded 250ms')), 250);
    })]);
  } finally { clearTimeout(timer); }
}
function g4Durations(events: readonly MetricObservation[]) {
  return events.filter((event): event is Extract<MetricObservation, { type: 'processing-duration' }> => event.type === 'processing-duration');
}

for (const status of ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'] as const) {
  test(`GREEN-G4 T01 ${status} original and replay each have exactly one ordered duration`, async () => {
    const h = financial(status === 'REJECTED' ? '0.00' : '100.00'); const observed = capture();
    const processor = g4Process(h.uow, observed.observe);
    const input = status === 'PENDING_REFERENCE' ? { ...h.input, kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'g4-missing' } : h.input;
    const original = await processor.execute(input);
    const replay = await processor.execute(input);
    expect(String(original.status)).toBe(status); expect(original.idempotentReplay).toBe(false);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(observed.values.map(event => event.type)).toEqual(['wager-status', 'processing-duration', 'duplicate', 'processing-duration']);
    expect(observed.values[0]).toEqual({ type: 'wager-status', status });
    expect(observed.values[2]).toEqual({ type: 'duplicate', kind: 'replay' });
    expect(g4Durations(observed.values)).toHaveLength(2);
    for (const event of g4Durations(observed.values)) { expect(Number.isSafeInteger(event.durationMs)).toBe(true); expect(event.durationMs).toBeGreaterThanOrEqual(0); }
    expect(h.inserted).toHaveLength(1); expect(h.entries).toHaveLength(status === 'PROCESSED' ? 1 : 0);
  });
}

for (const replay of [false, true]) for (const failCommit of [false, true]) {
  test(`GREEN-G4 T02 replay=${replay} observes only confirmed UoW; failedCommit=${failCommit}`, async () => {
    const h = financial(); const observed = capture(); const reached = g4Deferred<void>(); const release = g4Deferred<void>();
    const failure = new Error('G4 synthetic commit failure');
    const isolatedWallet = Wallet.rehydrate({ id: h.wallet.id, playerId: h.wallet.playerId, currency: h.wallet.currency,
      balance: h.wallet.balance, version: h.wallet.version, createdAt: at, updatedAt: at });
    const winner = historical(h);
    const store = { ...h.store, getWallet: async () => isolatedWallet, findIdentity: async () => replay ? [winner] : [],
      updateWallet: async () => {}, insertWager: async () => {}, appendLedger: async () => {}, enqueue: async () => {} } as FinancialStore;
    const uow: FinancialUnitOfWork = { async run(work) {
      const result = await work(store); reached.resolve(); await release.promise;
      if (failCommit) throw failure;
      return result;
    } };
    const operation = g4Process(uow, observed.observe).execute(h.input);
    const outcome = operation.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try { await reached.promise; expect(observed.values).toEqual([]); }
    finally { release.resolve(); }
    const result = await outcome;
    if (failCommit) { expect(result.error).toBe(failure); expect(observed.values).toEqual([]); }
    else {
      expect(result.error).toBeUndefined(); expect(result.value?.idempotentReplay).toBe(replay);
      expect(observed.values.map(event => event.type)).toEqual([replay ? 'duplicate' : 'wager-status', 'processing-duration']);
    }
    expect(h.wallet.balance.toString()).toBe('100.00'); expect(h.entries).toEqual([]); expect(h.outbox).toEqual([]);
  });
}

test('GREEN-G4 T03 definitive conflict emits only conflict and duration and preserves the error', async () => {
  const h = financial(); const observed = capture(); const failure = new IdempotencyConflictError('G4 definitive conflict');
  const uow: FinancialUnitOfWork = { async run() { throw failure; } };
  await expect(g4Process(uow, observed.observe).execute(h.input)).rejects.toBe(failure);
  expect(observed.values.map(event => event.type)).toEqual(['duplicate', 'processing-duration']);
  expect(observed.values[0]).toEqual({ type: 'duplicate', kind: 'conflict' });
  expect(h.entries).toEqual([]); expect(h.outbox).toEqual([]);
});

for (const constraint of ['uq_wallet_player_currency', 'unknown', undefined]) {
  test(`GREEN-G4 T04 wallet 23505 constraint ${constraint} respects its whitelist`, async () => {
    const observed = capture(); const failure = { code: '23505', ...(constraint === undefined ? {} : { constraint }) };
    const uow: FinancialUnitOfWork = { async run() { throw failure; } };
    const operation = g4Open(g4Wallet(uow, observed.observe));
    if (constraint === 'uq_wallet_player_currency') {
      await expect(operation).rejects.toBeInstanceOf(ConflictError);
      expect(observed.values).toEqual([{ type: 'concurrency-conflict', code: '23505' }]);
    } else { await expect(operation).rejects.toBe(failure); expect(observed.values).toEqual([]); }
  });
}

for (const constraint of ['uq_wager_idempotency', 'uq_wager_provider_external', 'unknown', undefined]) {
  test(`GREEN-G4 T04 wager 23505 constraint ${constraint} respects its whitelist before reread`, async () => {
    const h = financial(); const observed = capture(); let runs = 0;
    const known = constraint === 'uq_wager_idempotency' || constraint === 'uq_wager_provider_external';
    const failure = { code: '23505', ...(constraint === undefined ? {} : { constraint }) };
    const winner = historical(h); h.store.findIdentity = async () => [winner];
    const uow: FinancialUnitOfWork = { async run(work) {
      runs++; if (runs === 1) throw failure;
      if (runs === 2) expect(observed.values).toEqual([{ type: 'concurrency-conflict', code: '23505' }]);
      return work(h.store as FinancialStore);
    } };
    const operation = g4Process(uow, observed.observe).execute(h.input);
    if (known) {
      const result = await operation; expect(result.transactionId).toBe(winner.id); expect(result.idempotentReplay).toBe(true);
      expect(runs).toBe(3);
      expect(observed.values.map(event => event.type)).toEqual(['concurrency-conflict', 'retry-scheduled', 'duplicate', 'processing-duration']);
      expect(observed.values[2]).toEqual({ type: 'duplicate', kind: 'replay' });
    } else { await expect(operation).rejects.toBe(failure); expect(runs).toBe(1); expect(observed.values).toEqual([]); }
    expect(h.wallet.balance.toString()).toBe('100.00'); expect(h.entries).toEqual([]); expect(h.outbox).toEqual([]);
  });
}

for (const component of ['wallet', 'wager'] as const) for (const maxAttempts of [1, 3]) for (const code of ['40P01', '40001', '55P03', '57014'] as const) {
  test(`GREEN-G4 T05 ${component} ${code} limit ${maxAttempts} separates conflicts from actual retries`, async () => {
    const h = financial(); const observed = capture(); let runs = 0; const failure = { code };
    const uow: FinancialUnitOfWork = { async run() { runs++; throw failure; } };
    const operation = component === 'wallet' ? g4Open(g4Wallet(uow, observed.observe, { maxAttempts }))
      : g4Process(uow, observed.observe, { maxAttempts }).execute(h.input);
    let caught: unknown; try { await operation; } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RetryExhaustedError); expect((caught as Error).cause).toBe(failure); expect(runs).toBe(maxAttempts);
    const expected: MetricObservation[] = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      expected.push({ type: 'concurrency-conflict', code });
      if (attempt + 1 < maxAttempts) expected.push({ type: 'retry-scheduled', target: component === 'wallet' ? 'walletUow' : 'wagerUow' });
    }
    expect(observed.values).toEqual(expected); expect(h.entries).toEqual([]); expect(h.outbox).toEqual([]);
  });
}

for (const mode of ['compatible', 'conflict', 'exhausted', 'reread-fails'] as const) {
  test(`GREEN-G4 T06 ${mode} reread is not a replay or an independent retry`, async () => {
    const h = financial(); const observed = capture(); let runs = 0;
    const winner = historical(h, mode === 'conflict' ? '26.00' : '25.00'); h.store.findIdentity = async () => [winner];
    const rereadFailure = new Error('G4 reread failure');
    const uow: FinancialUnitOfWork = { async run(work) {
      runs++; if (runs === 1) throw { code: '23505', constraint: 'uq_wager_idempotency' };
      if (runs === 2) {
        expect(observed.values).toEqual([{ type: 'concurrency-conflict', code: '23505' }]);
        if (mode === 'reread-fails') throw rereadFailure;
      }
      return work(h.store as FinancialStore);
    } };
    const operation = g4Process(uow, observed.observe, { maxAttempts: mode === 'exhausted' ? 1 : 3 }).execute(h.input);
    if (mode === 'compatible') {
      expect((await operation).idempotentReplay).toBe(true); expect(runs).toBe(3);
      expect(observed.values.map(event => event.type)).toEqual(['concurrency-conflict', 'retry-scheduled', 'duplicate', 'processing-duration']);
      expect(observed.values[2]).toEqual({ type: 'duplicate', kind: 'replay' });
    } else if (mode === 'conflict') {
      await expect(operation).rejects.toBeInstanceOf(IdempotencyConflictError); expect(runs).toBe(2);
      expect(observed.values.map(event => event.type)).toEqual(['concurrency-conflict', 'duplicate', 'processing-duration']);
      expect(observed.values[1]).toEqual({ type: 'duplicate', kind: 'conflict' });
    } else {
      if (mode === 'exhausted') await expect(operation).rejects.toBeInstanceOf(RetryExhaustedError);
      else await expect(operation).rejects.toBe(rereadFailure);
      expect(runs).toBe(2); expect(observed.values).toEqual([{ type: 'concurrency-conflict', code: '23505' }]);
    }
    expect(h.entries).toEqual([]); expect(h.outbox).toEqual([]);
  });
}

for (const mode of ['original', 'replay', 'conflict'] as const) {
  test(`GREEN-G4 T07 ${mode} samples monotonic time before output observers and logging`, async () => {
    const h = financial(); const observed = capture(); let clock = 100.25; let runs = 0;
    const failure = new IdempotencyConflictError('G4 timed conflict');
    const uow: FinancialUnitOfWork = { async run(work, isolation) {
      runs++;
      if (runs === 1) throw { code: '40001' };
      if (mode === 'conflict') { clock = 165.99; throw failure; }
      if (mode === 'replay') h.store.findIdentity = async () => [historical(h)];
      const result = await h.uow.run(work, isolation); clock = 165.99; return result;
    } };
    const observer: Observation = event => { observed.observe(event); if (event.type === 'wager-status' || event.type === 'duplicate') clock += 1000; };
    const processor = g4Process(uow, observer, { operationalLog: () => { clock += 1000; } });
    const time = spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      if (mode === 'conflict') await expect(processor.execute(h.input)).rejects.toBe(failure);
      else expect((await processor.execute(h.input)).idempotentReplay).toBe(mode === 'replay');
      expect(time).toHaveBeenCalledTimes(2);
    } finally { time.mockRestore(); }
    expect(runs).toBe(2);
    expect(observed.values.map(event => event.type)).toEqual(['concurrency-conflict', 'retry-scheduled', mode === 'original' ? 'wager-status' : 'duplicate', 'processing-duration']);
    expect(g4Durations(observed.values)).toEqual([{ type: 'processing-duration', durationMs: 65 }]);
    expect(clock).toBe(2165.99);
  });
}

for (const mode of ['start-throws', 'end-throws', 'start-nan', 'start-negative', 'end-infinity', 'negative-elapsed', 'unsafe-elapsed'] as const) {
  test(`GREEN-G4 T07 ${mode} suppresses only duration without changing the result`, async () => {
    const h = financial(); const observed = capture(); let reads = 0;
    const time = spyOn(performance, 'now').mockImplementation(() => {
      const first = reads++ === 0;
      if ((first && mode === 'start-throws') || (!first && mode === 'end-throws')) throw new Error('G4 clock failure');
      if (first) return mode === 'start-nan' ? Number.NaN : mode === 'start-negative' ? -1 : 100;
      return mode === 'end-infinity' ? Number.POSITIVE_INFINITY : mode === 'negative-elapsed' ? 99 : mode === 'unsafe-elapsed' ? Number.MAX_SAFE_INTEGER + 1000 : 125;
    });
    let result: ProcessWagerResult;
    try { result = await g4Process(h.uow, observed.observe).execute(h.input); }
    finally { time.mockRestore(); }
    expect(result!.status).toBe(WagerTransactionStatus.Processed); expect(result!.balance.amount).toBe('75.00');
    expect(observed.values).toEqual([{ type: 'wager-status', status: 'PROCESSED' }]);
    expect(h.entries).toHaveLength(1); expect(h.outbox).toHaveLength(2);
  });
}

for (const mode of ['invalid-input', 'missing-wallet', 'persistence', 'unknown-sql', 'unexpected'] as const) {
  test(`GREEN-G4 T08 ${mode} remains unclassified and emits no outcome metrics`, async () => {
    const h = financial(); const observed = capture();
    const failure = mode === 'persistence' ? new G4PersistenceError('G4 invariant') : mode === 'unknown-sql' ? { code: '23505', constraint: 'unknown' } : new Error('G4 unexpected');
    if (mode === 'missing-wallet') h.store.getWallet = async () => undefined;
    const uow = mode === 'invalid-input' || mode === 'missing-wallet' ? h.uow : { async run() { throw failure; } } as FinancialUnitOfWork;
    const operation = g4Process(uow, observed.observe).execute(mode === 'invalid-input' ? { ...h.input, money: { amount: 'invalid', currency: 'BRL' } } : h.input);
    if (mode === 'invalid-input') await expect(operation).rejects.toThrow();
    else if (mode === 'missing-wallet') await expect(operation).rejects.toBeInstanceOf(G4NotFoundError);
    else await expect(operation).rejects.toBe(failure);
    expect(observed.values).toEqual([]); expect(h.entries).toEqual([]); expect(h.outbox).toEqual([]);
  });
}

for (const fault of ['metrics', 'legacy-metric', 'legacy-log', 'structured-log', 'fallback'] as const) {
  test(`GREEN-G4 T09 ${fault} preserves independent M8, cumulative CP04 and logging precedence`, async () => {
    const h = financial(); h.store.ledgerTotal = async () => ({ amount: '95.00', count: 1 });
    const observed = capture(); const totals: bigint[] = []; let legacyLogs = 0; let structuredLogs = 0;
    const warn = spyOn(console, 'warn').mockImplementation(() => { if (fault === 'fallback') throw new Error('G4 warn fault'); });
    const telemetry = {
      operationalMetrics: (event: MetricObservation) => { observed.observe(event); if (fault === 'metrics') throw new Error('G4 metric fault'); },
      metric: (total: bigint) => { totals.push(total); if (fault === 'legacy-metric') throw new Error('G4 cumulative fault'); },
      ...(fault === 'structured-log' ? { operationalLog: () => { structuredLogs++; throw new Error('G4 structured fault'); } }
        : fault === 'fallback' ? { operationalLog: undefined } : { log: () => { legacyLogs++; if (fault === 'legacy-log') throw new Error('G4 legacy log fault'); } }),
    };
    const reconcile = new ReconcileWalletUseCase(h.uow, telemetry);
    try {
      for (let index = 0; index < 3; index++) expect((await reconcile.execute(h.wallet.id)).difference.amount).toBe('5.00');
      expect(reconcile.divergenceObservations).toBe(3n); expect(totals).toEqual([1n, 2n, 3n]);
      expect(observed.values).toEqual(Array.from({ length: 3 }, () => ({ type: 'reconciliation-divergence' })));
      expect(legacyLogs).toBe(fault === 'structured-log' || fault === 'fallback' ? 0 : 3);
      expect(structuredLogs).toBe(fault === 'structured-log' ? 3 : 0);
      expect(warn).toHaveBeenCalledTimes(fault === 'fallback' ? 3 : 0);
      expect(h.wallet.balance.toString()).toBe('100.00'); expect(h.entries).toEqual([]);
    } finally { warn.mockRestore(); }
  });
}

for (const failCommit of [false, true]) {
  test(`GREEN-G4 T09 no M8 on consistent reconciliation or failed commit=${failCommit}`, async () => {
    const h = financial(); const observed = capture(); const failure = new Error('G4 reconciliation commit failure');
    const uow: FinancialUnitOfWork = { async run(work, isolation) { const result = await h.uow.run(work, isolation); if (failCommit) throw failure; return result; } };
    const telemetry = { operationalLog: undefined, operationalMetrics: observed.observe };
    const reconcile = new ReconcileWalletUseCase(uow, telemetry);
    if (failCommit) await expect(reconcile.execute(h.wallet.id)).rejects.toBe(failure);
    else expect((await reconcile.execute(h.wallet.id)).consistent).toBe(true);
    expect(observed.values).toEqual([]); expect(reconcile.divergenceObservations).toBe(0n);
  });
}

test('GREEN-G4 T10 selective financial DI uses the graph collector and preserves query injection', async () => {
  const h = financial(); const collector = new DefaultOperationalMetricsCollector();
  const database = DatabaseModule.forHttp(h.uow, { metrics: collector });
  withMetadataDatabaseUrl(() => {
    for (const module of [database, DatabaseModule.forRoot({ metrics: collector })]) {
      for (const token of [CreateWalletUseCase, ProcessWagerTransactionUseCase, ReconcileWalletUseCase]) {
        expect(factoryProvider(dynamicShape(module), token)?.inject).toEqual([FINANCIAL_UNIT_OF_WORK, OPERATIONAL_METRICS_TOKEN]);
      }
      for (const token of [G4GetWallet, G4ListLedger, G4GetWager]) {
        expect(factoryProvider(dynamicShape(module), token)?.inject).toEqual([FINANCIAL_UNIT_OF_WORK]);
      }
    }
  });
  const a = await NestFactory.createApplicationContext(database, { logger: false, abortOnError: false });
  let b: typeof a | undefined;
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    b = await NestFactory.createApplicationContext(DatabaseModule.forHttp(h.uow), { logger: false, abortOnError: false });
    expect(a.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN)).toBe(collector);
    expect(b.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN)).not.toBe(collector);
    const real = h.uow.run.bind(h.uow); let calls = 0;
    h.uow.run = async (work, isolation) => { if (++calls === 1) throw { code: '55P03' }; return real(work, isolation); };
    await g4Open(a.get(CreateWalletUseCase));
    await a.get(ProcessWagerTransactionUseCase).execute(h.input);
    h.store.ledgerTotal = async () => ({ amount: '74.00', count: 1 });
    expect((await a.get(ReconcileWalletUseCase).execute(h.wallet.id)).consistent).toBe(false);
    expect(collector.snapshot().retries.walletUow).toBe(1);
    expect(collector.snapshot().transactionsByStatus.PROCESSED).toBe(1);
    expect(collector.snapshot().processingDurationMs.count).toBe(1);
    expect(collector.snapshot().reconciliation.divergences).toBe(1);
    expect(b.get<OperationalMetricsCollector>(OPERATIONAL_METRICS_TOKEN).snapshot()).toEqual(emptySnapshot as ReturnType<OperationalMetricsCollector['snapshot']>);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { try { await b?.close(); await a.close(); } finally { warn.mockRestore(); } }
});

for (const mode of observerFailures) {
  test(`GREEN-G4 T11 ${mode} cannot alter financial effects or suppress consecutive outcomes`, async () => {
    const h = financial(); const observed = capture(); const fault = defectiveMetricsObserver(mode, [], () => {});
    let echo: Observation = () => {};
    const observer: Observation = event => { observed.observe(event); if (mode === 'reentrant') { echo(event); return; } return fault(event); };
    echo = g4Emitter(observer);
    const unhandled: unknown[] = []; const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const result = await g4Deadline(g4Process(h.uow, observer).execute(h.input));
      expect(result.balance.amount).toBe('75.00'); expect(result.idempotentReplay).toBe(false);
      expect(h.wallet.version).toBe(2); expect(h.entries).toHaveLength(1); expect(h.outbox).toHaveLength(2);
      expect(h.calls.filter(call => call === 'uow:start')).toHaveLength(1);
      expect(observed.values.map(event => event.type)).toEqual(['wager-status', 'processing-duration']);
      await new Promise<void>(resolve => setImmediate(resolve)); expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', listener); }
  });
}

test('GREEN-G4 T12 constructors without metrics and explicit undefined preserve results and legacy logs', async () => {
  const h = financial(); const records: unknown[] = [];
  const options = { now: () => at, operationalMetrics: undefined, operationalLog: (record: unknown) => { records.push(record); } };
  const wallet = await g4Open(new CreateWalletUseCase(h.uow, options)); expect(wallet.balance.toString()).toBe('0.00');
  const processor = new ProcessWagerTransactionUseCase(h.uow, options);
  const original = await processor.execute(h.input); const replay = await processor.execute(h.input);
  expect(replay).toEqual({ ...original, idempotentReplay: true });
  await expect(processor.execute({ ...h.input, money: { amount: '26.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(records.map(record => (record as { event: string }).event)).toEqual(['wallet_created', 'wager_processed', 'wager_replayed', 'idempotency_conflict']);
  expect(h.wallet.balance.toString()).toBe('75.00'); expect(h.entries).toHaveLength(1); expect(h.outbox).toHaveLength(2);
  expect(new CreateWalletUseCase(h.uow)).toBeInstanceOf(CreateWalletUseCase);
  expect(new ProcessWagerTransactionUseCase(h.uow)).toBeInstanceOf(ProcessWagerTransactionUseCase);
  expect(new ReconcileWalletUseCase(h.uow)).toBeInstanceOf(ReconcileWalletUseCase);
});

// GREEN-G5 additions. These controlled factories/UoWs do not start external graphs or prove PostgreSQL rollback.
import { CLOCK as G5_CLOCK, type ClockPort as G5Clock } from '../../src/shared/application/clock';
import { AwsSqsConsumerTransport as G5ConsumerTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-consumer-transport';
import { AwsSqsOutboxTransport as G5OutboxTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-outbox-transport';

// Real additive signatures: typecheck also covers omitted, partial and explicitly undefined options.
const g5ForConsumer = (options?: G3CompositionOptions): DynamicModule => MessagingModule.forConsumer(options);
const g5ForPublisher = (options?: G3CompositionOptions): DynamicModule => MessagingModule.forPublisher(options);
const g5ForPending = (options?: G3CompositionOptions): DynamicModule => WageringModule.forPendingReferences(options);
const g5Barrier = () => new Promise<void>(resolve => setImmediate(resolve));
function g5Invoke(provider: FactoryProviderShape, args: unknown[]): unknown {
  if (typeof provider.useFactory !== 'function') throw new Error('Expected controlled useFactory');
  return Reflect.apply(provider.useFactory, undefined, args);
}
function g5GraphCollector(database: DynamicModuleShape): OperationalMetricsCollector {
  expect(database.exports).toContain(OPERATIONAL_METRICS_TOKEN);
  return g5Invoke(factoryProvider(database, OPERATIONAL_METRICS_TOKEN)!, []) as OperationalMetricsCollector;
}
function g5Envelope() {
  return { body: JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), correlationId,
    occurredAt: at.toISOString(), data: financial().input }), transportMessageId: randomUUID(), receiptHandle: 'g5-receipt', receiveCount: 1 };
}
function g5Transport(calls: string[] = []): SqsConsumerTransport {
  return { receive: async () => undefined, retry: async () => { calls.push('retry'); },
    acknowledge: async () => { calls.push('ack'); }, deadLetter: async () => { calls.push('dlq'); } };
}
function g5Consumer(input?: OperationalMetricsInput, transport = g5Transport(),
  extra: NonNullable<ConstructorParameters<typeof SqsWagerConsumer>[5]> = {}) {
  const options: typeof extra & OperationalMetricsOptions = { ...extra, operationalMetrics: input };
  return new SqsWagerConsumer({ execute: async () => { throw { code: '40001' }; } }, transport, { now: () => at }, consumerConfig({}), () => {}, options);
}
function g5Outbox(input?: OperationalMetricsInput, clock: G5Clock = { now: () => at }) {
  const eventId = randomUUID(); const occurredAt = new Date(at.getTime() - 120); const calls: string[] = [];
  const message = OutboxMessage.rehydrate({ id: eventId, aggregateId: randomUUID(), eventType: 'WalletBalanceChanged', occurredAt,
    attempts: 0, nextAttemptAt: at, payload: { eventId, occurredAt: occurredAt.toISOString(), data: {} } });
  const claim = { message, workerId: 'g5-owner', leaseToken: randomUUID(), leaseUntil: new Date(at.getTime() + 10000) };
  const store: Partial<FinancialStore> = { claimNextOutbox: async () => { calls.push('claim'); return claim; },
    completeOutbox: async () => { calls.push('complete'); return true; }, failOutbox: async () => { calls.push('fail'); return true; } };
  const uow: FinancialUnitOfWork = { run: async work => work(store as FinancialStore) };
  const transport = { publish: async () => { calls.push('publish'); } };
  const make = (work = uow, extras: Partial<ConstructorParameters<typeof OutboxPublisher>[4]> = {}) => {
    const options: ConstructorParameters<typeof OutboxPublisher>[4] & OperationalMetricsOptions = {
      workerId: 'g5-worker', diagnose: () => {}, ...extras, operationalMetrics: input,
    };
    return new OutboxPublisher(work, transport, clock, workerConfig({}), options);
  };
  return { eventId, message, claim, store, uow, transport, calls, make };
}
function g5CommitGate(base: FinancialUnitOfWork, gatedCall: number, fail: boolean) {
  const reached = g4Deferred<void>(); const release = g4Deferred<void>(); let calls = 0;
  const failure = new G4PersistenceError('G5 synthetic commit failure');
  const uow: FinancialUnitOfWork = { run: async (work, isolation) => {
    const index = ++calls; const result = await base.run(work, isolation);
    if (index === gatedCall) { reached.resolve(); await release.promise; if (fail) throw failure; }
    return result;
  } };
  return { reached, release, uow, failure };
}

for (const failed of [false, true]) test(`GREEN-G5 T01 Consumer retry waits for confirmed visibility failed=${failed}`, async () => {
  const observed = capture(); const entered = g4Deferred<void>(); const release = g4Deferred<void>(); const transport = g5Transport();
  transport.retry = async (receipt, seconds) => { expect(receipt).toBe('g5-receipt'); expect(seconds).toBe(consumerConfig({}).retryBaseSeconds);
    entered.resolve(); await release.promise; if (failed) throw new Error('visibility failed'); };
  const operation = g5Consumer(observed.observe, transport).handle(g5Envelope());
  try { await entered.promise; expect(observed.values).toEqual([]); }
  finally { release.resolve(); }
  expect(await operation).toEqual({ action: 'retry', code: 'POSTGRES_TRANSIENT' });
  expect(observed.values).toEqual(failed ? [] : [{ type: 'retry-scheduled', target: 'sqsConsumer' }]);
});

for (const failed of ['none', 'send', 'ack'] as const) test(`GREEN-G5 T02 DLQ requires both confirmations failed=${failed}`, async () => {
  const observed = capture(); const calls: string[] = []; const sendEntered = g4Deferred<void>(); const send = g4Deferred<void>();
  const ackEntered = g4Deferred<void>(); const ack = g4Deferred<void>(); const transport = g5Transport(calls);
  transport.deadLetter = async () => { calls.push('dlq'); sendEntered.resolve(); await send.promise; if (failed === 'send') throw new Error('send failed'); };
  transport.acknowledge = async () => { calls.push('ack'); ackEntered.resolve(); await ack.promise; if (failed === 'ack') throw new Error('ack failed'); };
  const operation = g5Consumer(observed.observe, transport).handle({ ...g5Envelope(), body: '{bad-json' });
  try {
    await sendEntered.promise; expect(observed.values).toEqual([]); send.resolve();
    if (failed !== 'send') { await ackEntered.promise; expect(observed.values).toEqual([]); }
  } finally { send.resolve(); ack.resolve(); }
  const result = await operation;
  expect(result.action).toBe(failed === 'none' ? 'dead-lettered' : 'retry');
  expect(calls).toEqual(failed === 'send' ? ['dlq', 'retry'] : failed === 'ack' ? ['dlq', 'ack', 'retry'] : ['dlq', 'ack']);
  expect(observed.values).toEqual(failed === 'none' ? [{ type: 'dlq-transfer-confirmed' }] : [{ type: 'retry-scheduled', target: 'sqsConsumer' }]);
});

for (const phase of ['retry', 'publication'] as const) for (const failed of [false, true]) {
  test(`GREEN-G5 ${phase === 'retry' ? 'T03' : 'T04'} Outbox waits for UoW settlement failed=${failed}`, async () => {
    const observed = capture(); const h = g5Outbox(observed.observe); const gate = g5CommitGate(h.uow, 2, failed);
    if (phase === 'retry') h.transport.publish = async () => { h.calls.push('publish'); throw new Error('send failed'); };
    const operation = h.make(gate.uow).publishNext();
    try { await gate.reached.promise; expect(h.calls).toEqual(['claim', 'publish', phase === 'retry' ? 'fail' : 'complete']); expect(observed.values).toEqual([]); }
    finally { gate.release.resolve(); }
    expect((await operation).action).toBe(failed ? phase === 'retry' ? 'retry-pending' : 'confirmation-pending' : phase === 'retry' ? 'retry-scheduled' : 'published');
    expect(observed.values).toEqual(failed ? [] : phase === 'retry'
      ? [{ type: 'retry-scheduled', target: 'outboxPublisher' }] : [{ type: 'outbox-publication-confirmed', lagMs: 120 }]);
    expect(h.message.attempts).toBe(phase === 'retry' ? 1 : 0);
  });
}

for (const sample of ['normal', 'regressive', 'extreme', 'throwing', 'nan'] as const) {
  test(`GREEN-G5 T05 lag uses the SQL sample once and isolates invalid dates: ${sample}`, async () => {
    const observed = capture(); let reads = 0; const confirmedAt = new Date(at.getTime() + 50);
    const clock = { now: () => { reads++; if (reads > 3) throw new Error('second lag clock read'); return reads === 3 ? confirmedAt : at; } };
    const h = g5Outbox(observed.observe, clock); let sqlAt: Date | undefined;
    h.store.completeOutbox = async (id, owner, token, timestamp) => {
      expect(id).toBe(h.eventId); expect(owner).toBe(h.claim.workerId); expect(token).toBe(h.claim.leaseToken);
      sqlAt = timestamp;
      // Hostile samples become observable only after SQL confirmation, without changing the fencing argument.
      if (sample === 'extreme') timestamp.setTime(8640000000000000);
      if (sample !== 'normal') h.claim.message = new Proxy(h.message, { get(target, key) {
        if (key !== 'occurredAt') return Reflect.get(target, key, target);
        if (sample === 'throwing') throw new Error('bad metric sample');
        return new Date(sample === 'regressive' ? timestamp.getTime() + 1 : sample === 'extreme' ? -8640000000000000 : Number.NaN);
      } });
      return true;
    };
    expect(await h.make().publishNext()).toEqual({ action: 'published', eventId: h.eventId });
    expect(reads).toBe(3); expect(sqlAt).toBeDefined();
    if (sample === 'normal') { expect(sqlAt!.getTime()).toBe(confirmedAt.getTime()); expect(observed.values).toEqual([{ type: 'outbox-publication-confirmed', lagMs: 170 }]); }
    else expect(observed.values).toEqual(sample === 'regressive' ? [{ type: 'outbox-publication-confirmed', lagMs: 0 }] : []);
  });
}

for (const code of ['40P01', '40001', '55P03', '57014'] as const) for (const maxAttempts of [1, 3]) {
  test(`GREEN-G5 T06 Pending ${code} maxAttempts=${maxAttempts} separates occurrences and retries`, async () => {
    const observed = capture(); let calls = 0; const failure = { code };
    const uow: FinancialUnitOfWork = { run: async () => { calls++; throw failure; } };
    const options: NonNullable<ConstructorParameters<typeof PendingReferenceWorker>[3]> & OperationalMetricsOptions = {
      maxAttempts, operationalMetrics: observed.observe, diagnose: () => {},
    };
    const worker = new PendingReferenceWorker(uow, { now: () => at }, pendingReferencePolicy({}), options);
    await expect(worker.resolve({ id: randomUUID(), walletId: randomUUID() })).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(maxAttempts);
    expect(observed.values).toEqual(Array.from({ length: maxAttempts }, (_, i) => [
      { type: 'concurrency-conflict' as const, code }, ...(i + 1 < maxAttempts ? [{ type: 'retry-scheduled' as const, target: 'pendingReference' as const }] : []),
    ]).flat());
  });
}
for (const code of ['23505', 'XX000']) test(`GREEN-G5 T06 Pending excludes unrecognized ${code}`, async () => {
  const observed = capture(); const failure = { code }; const uow: FinancialUnitOfWork = { run: async () => { throw failure; } };
  const options: NonNullable<ConstructorParameters<typeof PendingReferenceWorker>[3]> & OperationalMetricsOptions = { operationalMetrics: observed.observe };
  const worker = new PendingReferenceWorker(uow, { now: () => at }, pendingReferencePolicy({}), options);
  await expect(worker.resolve({ id: randomUUID(), walletId: randomUUID() })).rejects.toBe(failure); expect(observed.values).toEqual([]);
});

for (const action of ['processed', 'rejected', 'rescheduled'] as const) for (const failed of [false, true]) {
  test(`GREEN-G5 T07 Pending ${action} waits for commit failed=${failed}`, async () => {
    const observed = capture(); const h = await pendingResolutionFixture(observed.observe); h.setReference(action === 'rescheduled' ? 'missing' : action);
    observed.values.length = 0; const gate = g5CommitGate(h.h.uow, 1, failed);
    const operation = h.worker(gate.uow).resolve({ id: h.pending.id, walletId: h.h.wallet.id });
    const completed = operation.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try { await gate.reached.promise; expect(observed.values).toEqual([]); }
    finally { gate.release.resolve(); }
    const result = await completed;
    if (failed) { expect(result.error).toBe(gate.failure); expect(observed.values).toEqual([]); }
    else { expect(result.value?.action).toBe(action); expect(observed.values).toEqual([{ type: 'pending-reference-resolution', action }]); }
  });
}
test('GREEN-G5 T07 runOnce retry is not a scheduled retry or resolution', async () => {
  const observed = capture(); const h = await pendingResolutionFixture(observed.observe); observed.values.length = 0;
  h.h.store.findDuePendingWagers = async () => [h.pending]; h.h.store.getWallet = async () => { throw new G4PersistenceError('not transient'); };
  expect(await h.worker().runOnce()).toEqual([{ transactionId: h.pending.id, action: 'retry' }]); expect(observed.values).toEqual([]);
});

for (const component of ['SqsWagerConsumer', 'OutboxPublisher', 'PendingReferenceWorker'] as const) for (const mode of observerFailures) {
  test(`GREEN-G5 T08 ${component} delivers consecutive events despite ${mode}`, async () => {
    const observed = capture(); const fault = defectiveMetricsObserver(mode, [], () => {}); let echo: Observation = () => {};
    const observer: Observation = event => { observed.observe(event); if (mode === 'reentrant') return echo(event); return fault(event); };
    echo = g4Emitter(observer); const unhandled: unknown[] = []; const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      if (component === 'SqsWagerConsumer') {
        const consumer = g5Consumer(observer);
        await g4Deadline(consumer.handle(g5Envelope())); await g4Deadline(consumer.handle(g5Envelope()));
        expect(observed.values).toEqual(Array.from({ length: 2 }, () => ({ type: 'retry-scheduled', target: 'sqsConsumer' })));
      } else if (component === 'OutboxPublisher') {
        const h = g5Outbox(observer); const publisher = h.make();
        expect((await g4Deadline(publisher.publishNext())).action).toBe('published');
        expect((await g4Deadline(publisher.publishNext())).action).toBe('published');
        expect(observed.values).toEqual(Array.from({ length: 2 }, () => ({ type: 'outbox-publication-confirmed', lagMs: 120 })));
        expect(h.calls).toEqual(['claim', 'publish', 'complete', 'claim', 'publish', 'complete']);
      } else {
        const h = await pendingResolutionFixture(() => {}); h.setReference('processed'); let calls = 0;
        const real = h.h.uow.run.bind(h.h.uow); const uow: FinancialUnitOfWork = { run: async (work, isolation) => {
          if (++calls === 1) throw { code: '40P01' }; return real(work, isolation);
        } };
        const options: NonNullable<ConstructorParameters<typeof PendingReferenceWorker>[3]> & OperationalMetricsOptions = { operationalMetrics: observer };
        const worker = new PendingReferenceWorker(uow, { now: () => new Date(at.getTime() + 2000) }, pendingReferencePolicy({}), options);
        expect((await g4Deadline(worker.resolve({ id: h.pending.id, walletId: h.h.wallet.id }))).action).toBe('processed');
        expect(observed.values).toEqual([{ type: 'concurrency-conflict', code: '40P01' }, { type: 'retry-scheduled', target: 'pendingReference' },
          { type: 'pending-reference-resolution', action: 'processed' }]);
        expect(calls).toBe(2); expect(h.h.wallet.balance.toString()).toBe('110.00'); expect(h.h.entries).toHaveLength(1);
      }
      await g5Barrier(); expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', listener); }
  });
}
test('GREEN-G5 T08 object receivers and real collectors work in all three workers', async () => {
  const collector = new DefaultOperationalMetricsCollector();
  const object = { calls: 0, observe(event: OperationalMetricObservation) { expect(this).toBe(object); this.calls++; collector.observe(event); } };
  await g5Consumer(object).handle(g5Envelope()); await g5Outbox(object).make().publishNext();
  const h = await pendingResolutionFixture(() => {}); h.setReference('processed');
  const options: NonNullable<ConstructorParameters<typeof PendingReferenceWorker>[3]> & OperationalMetricsOptions = { operationalMetrics: object };
  await new PendingReferenceWorker(h.h.uow, { now: () => new Date(at.getTime() + 2000) }, pendingReferencePolicy({}), options)
    .resolve({ id: h.pending.id, walletId: h.h.wallet.id });
  expect(object.calls).toBe(3); expect(collector.snapshot().retries.sqsConsumer).toBe(1);
  expect(collector.snapshot().outboxLagMs.count).toBe(1); expect(collector.snapshot().pendingReference.processed).toBe(1);
  await g5Consumer(collector).handle(g5Envelope()); await g5Outbox(collector).make().publishNext();
  const other = await pendingResolutionFixture(() => {}); other.setReference('processed');
  const direct: NonNullable<ConstructorParameters<typeof PendingReferenceWorker>[3]> & OperationalMetricsOptions = { operationalMetrics: collector };
  await new PendingReferenceWorker(other.h.uow, { now: () => new Date(at.getTime() + 2000) }, pendingReferencePolicy({}), direct)
    .resolve({ id: other.pending.id, walletId: other.h.wallet.id });
  expect(collector.snapshot().retries.sqsConsumer).toBe(2); expect(collector.snapshot().outboxLagMs.count).toBe(2);
  expect(collector.snapshot().pendingReference.processed).toBe(2);
});

for (const kind of ['consumer', 'publisher', 'pending'] as const) {
  test(`GREEN-G5 T09 ${kind} metadata and controlled factory forward the same graph collector`, async () => {
    const collector = new DefaultOperationalMetricsCollector();
    const descriptor = withMetadataDatabaseUrl(() => kind === 'consumer' ? g5ForConsumer({ metrics: collector })
      : kind === 'publisher' ? g5ForPublisher({ metrics: collector }) : g5ForPending({ metrics: collector }));
    const shape = dynamicShape(descriptor); const database = importedModule(shape, DatabaseModule)!;
    expect(database).toBeDefined(); expect(g5GraphCollector(database)).toBe(collector);
    expect((shape.providers ?? []).filter(provider => typeof provider === 'object' && provider !== null && 'provide' in provider
      && provider.provide === OPERATIONAL_METRICS_TOKEN)).toHaveLength(0);
    const token = kind === 'consumer' ? SqsWagerConsumer : kind === 'publisher' ? OutboxPublisher : PendingReferenceWorker;
    const provider = factoryProvider(shape, token)!; expect(provider).toBeDefined();
    const inject = provider.inject!;
    expect(inject).toHaveLength(kind === 'pending' ? 4 : 5); expect(inject.at(-1)).toBe(OPERATIONAL_METRICS_TOKEN);
    expect(inject[0]).toBe(kind === 'consumer' ? ProcessWagerTransactionUseCase : FINANCIAL_UNIT_OF_WORK);
    expect(inject[kind === 'pending' ? 1 : 2]).toBe(G5_CLOCK);
    if (kind !== 'pending') expect(inject[1]).toBe(kind === 'consumer' ? G5ConsumerTransport : G5OutboxTransport);
    if (kind === 'consumer') {
      const calls: string[] = []; const worker = g5Invoke(provider, [{ execute: async () => { throw { code: '40001' }; } }, g5Transport(calls), { now: () => at }, consumerConfig({}), collector]) as SqsWagerConsumer;
      await worker.handle(g5Envelope()); expect(calls).toEqual(['retry']); expect(collector.snapshot().retries.sqsConsumer).toBe(1);
    } else if (kind === 'publisher') {
      const h = g5Outbox(); const worker = g5Invoke(provider, [h.uow, h.transport, { now: () => at }, workerConfig({}), collector]) as OutboxPublisher;
      expect((await worker.publishNext()).action).toBe('published'); expect(collector.snapshot().outboxLagMs.count).toBe(1);
    } else {
      const h = await pendingResolutionFixture(() => {}); h.setReference('processed');
      const worker = g5Invoke(provider, [h.h.uow, { now: () => new Date(at.getTime() + 2000) }, pendingReferencePolicy({}), collector]) as PendingReferenceWorker;
      expect((await worker.resolve({ id: h.pending.id, walletId: h.h.wallet.id })).action).toBe('processed');
      expect(collector.snapshot().pendingReference.processed).toBe(1);
    }
  });
}

test('GREEN-G5 T10 legacy descriptors, cancellation, logs and stopped loops preserve behavior', async () => {
  withMetadataDatabaseUrl(() => {
    for (const build of [g5ForConsumer, g5ForPublisher, g5ForPending]) {
      for (const options of [undefined, {}, { metrics: undefined }]) {
        const descriptor = build(options); expect(descriptor.imports).toHaveLength(1);
        const factory = () => g5GraphCollector(importedModule(dynamicShape(descriptor), DatabaseModule)!);
        expect(factory()).toBeInstanceOf(DefaultOperationalMetricsCollector); expect(factory()).not.toBe(factory());
      }
    }
  });
  const observed = capture(); const records: string[] = []; const calls: string[] = []; const transport = g5Transport(calls);
  const consumer = g5Consumer(observed.observe, transport, { operationalLog: event => { records.push(String(event['event'])); } });
  await consumer.handle(g5Envelope()); expect(records).toEqual(['sqs_received', 'sqs_retry_scheduled']);
  const stop = new AbortController(); stop.abort(); transport.receive = async () => g5Envelope();
  transport.retry = async (_receipt, seconds) => { calls.push(`release:${seconds}`); };
  const before = observed.values.length;
  expect(await consumer.pollOnce(stop.signal)).toEqual({ action: 'retry', code: 'POLL_CANCELLED' });
  expect(calls.at(-1)).toBe('release:0'); expect(observed.values).toHaveLength(before);
  await consumer.run(stop.signal);
  const h = g5Outbox(); const publisher = h.make(); await publisher.run(stop.signal); expect(h.calls).toEqual([]);
  const pending = new PendingReferenceWorker(g3NoWork, { now: () => at });
  expect(await pending.runOnce(100, stop.signal)).toEqual([]); await pending.run(stop.signal);
  expect(new SqsWagerConsumer({ execute: async () => { throw new Error('unused'); } }, g5Transport(), { now: () => at }, consumerConfig({}))).toBeInstanceOf(SqsWagerConsumer);
  expect(new OutboxPublisher(g3NoWork, { publish: async () => {} }, { now: () => at }, workerConfig({}), { workerId: 'legacy' })).toBeInstanceOf(OutboxPublisher);
});
