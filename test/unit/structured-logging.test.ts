import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FinancialStore, FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import type { ExecutionOptions } from '../../src/shared/application/execution';
import { IdempotencyConflictError } from '../../src/shared/domain/domain-errors';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { ProcessWagerTransactionUseCase, type ProcessWagerInput, type ProcessWagerResult } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { wagerPayloadHash } from '../../src/modules/wagering/application/wager-payload';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { SqsWagerConsumer, type ConsumerDiagnostic } from '../../src/modules/messaging/application/sqs-wager-consumer';
import type { SqsConsumerTransport } from '../../src/modules/messaging/application/sqs-transport';
import { consumerConfig } from '../../src/modules/messaging/application/consumer-config';
import { OutboxPublisher, type PublisherDiagnostic } from '../../src/modules/messaging/application/outbox-publisher';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { pendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { HttpExceptionFilter } from '../../src/shared/infrastructure/http-exception.filter';
import type { ArgumentsHost } from '@nestjs/common';
import { operationalEmitter, projectOperationalRecord, operationalEvents } from '../../src/shared/application/operational-logging';
import { structuredLogger } from '../../src/shared/infrastructure/structured-logger';

/** CP-05.B Gate RED. Only existing imports; no provisional production implementation.
 * operationalLog is the proposed optional test-facing injection seam, not a payload field.
 * On this baseline these additive options are ignored, producing missing-event failures.
 * Each test checks the legacy outcome before asserting the new logging contract.
 */
type RecordLine = Record<string, unknown>;
type Sink = (record: RecordLine) => unknown;
type LoggedOptions = ExecutionOptions & { operationalLog?: Sink };
const at = new Date('2026-11-05T12:00:00.000Z');
const correlationId = randomUUID();
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const catalogue = new Set(['wallet_created', 'wager_processed', 'wager_rejected', 'wager_pending_reference', 'wager_replayed',
  'idempotency_conflict', 'sqs_received', 'sqs_acked', 'sqs_retry_scheduled', 'sqs_ack_failed', 'sqs_dead_lettered',
  'outbox_sent', 'outbox_confirmed', 'outbox_confirmation_pending', 'outbox_retry_scheduled', 'outbox_lease_lost',
  'pending_reference_resolved', 'pending_reference_rescheduled', 'reconciliation_divergence', 'operational_error']);
const allowed = new Set(['timestamp', 'level', 'component', 'event', 'action', 'code', 'status', 'correlationId', 'messageId',
  'sqsMessageId', 'transactionId', 'walletId', 'providerId', 'eventId', 'receiveCount', 'idempotentReplay', 'durationMs']);
function publicRecord(record: RecordLine) {
  expect(Object.keys(record).every(key => allowed.has(key))).toBe(true);
  expect(catalogue.has(String(record['event']))).toBe(true);
  expect(record['timestamp']).toBeString();
  expect(Number.isFinite(Date.parse(String(record['timestamp'])))).toBe(true);
  expect(['debug', 'info', 'warn', 'error']).toContain(String(record['level']));
  expect(record['component']).toBeString();
  expect(record).not.toHaveProperty('phase');
  expect(record['action']).not.toBe('started');
  for (const key of ['receiveCount', 'durationMs']) if (key in record) {
    expect(typeof record[key]).toBe('number'); expect(Number.isFinite(record[key])).toBe(true); expect(Number(record[key])).toBeGreaterThanOrEqual(0);
  }
  if ('idempotentReplay' in record) expect(typeof record['idempotentReplay']).toBe('boolean');
  for (const key of ['transactionId', 'walletId', 'eventId']) if (key in record) expect(String(record[key])).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  for (const key of ['correlationId', 'messageId', 'sqsMessageId', 'providerId', 'action', 'code', 'status']) if (key in record) {
    expect(typeof record[key]).toBe('string'); expect(String(record[key])).not.toMatch(/[\r\n\u001b]/);
  }
  const encoded = JSON.stringify(record);
  expect(encoded.split('\n')).toHaveLength(1); expect(JSON.parse(encoded)).toEqual(record);
}
function capture() {
  const records: RecordLine[] = [];
  const sink: Sink = record => { records.push(record); };
  return { records, sink, events: () => records.map(record => record['event']) };
}
function financial(amount = '100.00') {
  const wallet = Wallet.rehydrate({ id: randomUUID(), playerId: 'player-private', currency: 'BRL', balance: money(amount), version: 1, createdAt: at, updatedAt: at });
  const calls: string[] = []; const outbox: OutboxMessage[] = []; const inserted: WagerTransaction[] = [];
  let active = false; let attempts = 0;
  const store: Partial<FinancialStore> = {
    getWallet: async () => wallet, findIdentity: async () => [], findWager: async () => undefined, isReversed: async () => false,
    insertWallet: async () => { calls.push('wallet-insert'); }, updateWallet: async () => { calls.push('wallet-update'); },
    insertWager: async tx => { inserted.push(tx); calls.push('wager-insert'); }, appendLedger: async () => { calls.push('ledger'); },
    enqueue: async event => { outbox.push(event); calls.push('outbox'); }, ledgerTotal: async () => ({ amount: '95.00', count: 1 }),
  };
  const uow: FinancialUnitOfWork = { run: async work => {
    attempts++; active = true;
    try { const result = await work(store as FinancialStore); calls.push('commit'); return result; }
    finally { active = false; }
  } };
  const input: ProcessWagerInput = { walletId: wallet.id, playerId: wallet.playerId, providerId: 'provider-a', externalTransactionId: 'external-private',
    idempotencyKey: 'key-private', roundId: 'round-private', gameId: 'game-private', kind: Kind.Bet, money: { amount: '25.00', currency: 'BRL' }, correlationId };
  return { wallet, store, uow, input, calls, outbox, inserted, active: () => active, attempts: () => attempts };
}
function options(sink: Sink): LoggedOptions { return { now: () => at, operationalLog: sink }; }
function history(h: ReturnType<typeof financial>, overrides: Partial<ProcessWagerInput> = {}) {
  const input = { ...h.input, ...overrides };
  return WagerTransaction.rehydrate({ ...input, id: randomUUID(), payloadHash: wagerPayloadHash(input), money: Money.from(input.money), createdAt: at,
    status: Status.Processed, processedAt: at, recordedBalance: money('75.00') });
}

test('B01/B06 wallet_created uses committed identity, allowlist and serializable single-line record', async () => {
  const h = financial(); const c = capture();
  const sink: Sink = record => { expect(h.active()).toBe(false); expect(h.calls.at(-1)).toBe('commit'); c.sink(record); };
  const wallet = await new CreateWalletUseCase(h.uow, options(sink)).execute({ playerId: h.wallet.playerId, initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId });
  expect(h.calls).toEqual(['wallet-insert', 'commit']);
  expect(c.events()).toEqual(['wallet_created']);
  expect(c.records[0]).toMatchObject({ walletId: wallet.id, correlationId }); publicRecord(c.records[0]!);
});

test.each([
  ['processed', '100.00', Kind.Bet, 'wager_processed', Status.Processed],
  ['rejected', '10.00', Kind.Bet, 'wager_rejected', Status.Rejected],
  ['pending', '100.00', Kind.Refund, 'wager_pending_reference', Status.PendingReference],
] as const)('B06 %s emits only after final UoW', async (_name, balance, kind, event, status) => {
  const h = financial(balance); const c = capture();
  const input = { ...h.input, kind, ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'missing-reference' } : {}) };
  const result = await new ProcessWagerTransactionUseCase(h.uow, options(record => { expect(h.active()).toBe(false); c.sink(record); })).execute(input);
  expect(result.status).toBe(status); expect(h.inserted).toHaveLength(1);
  expect(h.calls.filter(call => call === 'ledger')).toHaveLength(status === Status.Processed ? 1 : 0);
  expect(c.events()).toEqual([event]);
  expect(c.records[0]).toMatchObject({ transactionId: result.transactionId, walletId: h.wallet.id, providerId: input.providerId, correlationId });
  if (status === Status.Rejected) expect(c.records[0]?.['code']).toBe(FailureCode.InsufficientFundsBet);
  publicRecord(c.records[0]!);
});

test('B06 replay emits only historical transaction ID and no second movement', async () => {
  const h = financial(); const tx = history(h); const c = capture(); h.store.findIdentity = async () => [tx];
  const result = await new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(h.input);
  expect(result).toMatchObject({ transactionId: tx.id, idempotentReplay: true, balance: { amount: '75.00', currency: 'BRL' } });
  expect(h.inserted).toHaveLength(0); expect(h.outbox).toHaveLength(0); expect(h.calls).toEqual(['commit']);
  expect(c.events()).toEqual(['wager_replayed']); expect(c.records[0]).toMatchObject({ transactionId: tx.id, idempotentReplay: true });
});

test('B06 idempotency conflict preserves error, omits candidate ID and business secrets', async () => {
  const h = financial(); const tx = history(h, { money: { amount: '26.00', currency: 'BRL' } }); const c = capture();
  h.store.findIdentity = async () => [tx];
  await expect(new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(h.input)).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(h.calls).toEqual([]); expect(h.outbox).toHaveLength(0);
  expect(c.events()).toEqual(['idempotency_conflict']); expect(c.records[0]).not.toHaveProperty('transactionId');
  expect(JSON.stringify(c.records)).not.toContain(h.input.idempotencyKey); expect(JSON.stringify(c.records)).not.toContain(tx.payloadHash);
});

test.each(['40001', '40P01'])('B06 retry %s emits one final event after success', async code => {
  const h = financial(); const c = capture(); const real = h.uow.run; let attempts = 0;
  h.uow.run = async (work, isolation) => { if (++attempts === 1) throw { code }; return real(work, isolation); };
  const result = await new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(h.input);
  expect(attempts).toBe(2); expect(result.status).toBe(Status.Processed); expect(h.inserted).toHaveLength(1); expect(h.outbox).toHaveLength(2);
  expect(c.events()).toEqual(['wager_processed']);
});

test.each(['uq_wager_idempotency', 'uq_wager_provider_external'])('B06 known 23505 %s resolves historical replay', async constraint => {
  const h = financial(); const tx = history(h); const c = capture(); h.store.findIdentity = async () => [tx];
  const real = h.uow.run; let attempts = 0;
  h.uow.run = async (work, isolation) => { if (++attempts === 1) throw { code: '23505', constraint }; return real(work, isolation); };
  const result = await new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(h.input);
  expect(result.transactionId).toBe(tx.id); expect(result.idempotentReplay).toBe(true); expect(h.inserted).toHaveLength(0);
  expect(c.events()).toEqual(['wager_replayed']);
});

test('B06 PASS existing: unrelated 23505 is not silently classified as replay', async () => {
  const h = financial(); const c = capture(); const error = { code: '23505', constraint: 'unrelated_constraint' };
  h.uow.run = async () => { throw error; };
  await expect(new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(h.input)).rejects.toBe(error);
  expect(c.records).toEqual([]); expect(h.outbox).toEqual([]);
});

test('B01 PASS existing: directly constructed financial cases remain silent without a sink', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {}); const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const h = financial(); await new ProcessWagerTransactionUseCase(h.uow).execute(h.input);
    await new CreateWalletUseCase(h.uow).execute({ playerId: 'another-player', initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId });
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  } finally { log.mockRestore(); warn.mockRestore(); }
});

// All canaries are synthetic. Assertions check values as well as field names.
test.each(['postgres://synthetic:secret@host/db', 'Bearer synthetic-token', 'SELECT secret FROM private_table',
  'receiptHandle=SYNTHETIC_PRIVATE', 'private\nINJECTED_LOG', 'private\u001b[31m', 'x'.repeat(8192)])('B02 unsafe correlation sample %# is omitted, never copied', async canary => {
  const h = financial(); const c = capture();
  const result = await new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute({ ...h.input, correlationId: canary });
  expect(result.status).toBe(Status.Processed);
  expect(c.events()).toEqual(['wager_processed']);
  expect(c.records[0]).not.toHaveProperty('correlationId'); expect(JSON.stringify(c.records)).not.toContain(canary); publicRecord(c.records[0]!);
});

test('B02 arbitrary extra context, Error, headers and financial values are not projected', async () => {
  const h = financial(); const c = capture();
  const input = { ...h.input, headers: { authorization: 'Bearer SYNTHETIC_PRIVATE' }, error: new Error('SYNTHETIC_PRIVATE'),
    receiptHandle: 'SYNTHETIC_PRIVATE', payload: { password: 'SYNTHETIC_PRIVATE' }, event: 'SYNTHETIC_PRIVATE', action: 'started', code: 'SYNTHETIC_PRIVATE' };
  await new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(input);
  expect(c.events()).toEqual(['wager_processed']); publicRecord(c.records[0]!);
  const encoded = JSON.stringify(c.records);
  for (const value of ['SYNTHETIC_PRIVATE', '25.00', '75.00', 'key-private', 'player-private', 'external-private', 'round-private', 'game-private']) expect(encoded).not.toContain(value);
});

const faults: Array<[string, () => unknown]> = [
  ['sync throw', () => { throw new Error('SYNTHETIC_SINK_SECRET'); }],
  ['rejected promise', () => Promise.reject(new Error('SYNTHETIC_SINK_SECRET'))],
  ['throwing then getter', () => Object.defineProperty({}, 'then', { get() { throw new Error('getter'); } })],
  ['throwing then method', () => ({ then() { throw new Error('then'); } })],
  ['rejecting thenable', () => ({ then(_resolve: unknown, reject: (reason: unknown) => void) { reject(new Error('thenable')); } })],
  ['never resolving', () => new Promise(() => {})],
];
test.each(faults)('B03/B04 isolated sink: %s cannot replace result or create unhandled rejection', async (_name, fault) => {
  const unhandled: unknown[] = []; const listener = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection', listener);
  const h = financial(); let calls = 0; let settled = false; let result: ProcessWagerResult | undefined;
  const sink: Sink = () => { calls++; return fault(); };
  const operation = new ProcessWagerTransactionUseCase(h.uow, options(sink)).execute(h.input).then(value => { settled = true; result = value; });
  try {
    // Controlled UoW has no I/O; an event-loop turn distinguishes a stalled sink from completed work.
    await nextTurn(); expect(settled).toBe(true); await operation; await nextTurn();
    expect(result?.status).toBe(Status.Processed); expect(h.inserted).toHaveLength(1); expect(h.outbox).toHaveLength(2);
    expect(unhandled).toEqual([]); expect(calls).toBe(1);
  } finally { process.off('unhandledRejection', listener); }
});

test('B03 wallet creation succeeds even when selected sink throws', async () => {
  const h = financial(); let calls = 0;
  const wallet = await new CreateWalletUseCase(h.uow, options(() => { calls++; throw new Error('sink'); })).execute({
    playerId: h.wallet.playerId, initialBalance: { amount: '10.00', currency: 'BRL' }, correlationId });
  expect(wallet.balance.toString()).toBe('10.00'); expect(h.inserted).toHaveLength(1); expect(h.outbox).toHaveLength(2); expect(calls).toBe(1);
});

test.each(['replay', 'conflict', 'retry'] as const)('B03 throwing sink preserves %s decision', async mode => {
  const h = financial(); let calls = 0; const sink: Sink = () => { calls++; throw new Error('sink'); };
  if (mode !== 'retry') h.store.findIdentity = async () => [history(h, mode === 'conflict' ? { money: { amount: '26.00', currency: 'BRL' } } : {})];
  else { const real = h.uow.run; let attempt = 0; h.uow.run = async (work, isolation) => { if (++attempt === 1) throw { code: '40001' }; return real(work, isolation); }; }
  const operation = new ProcessWagerTransactionUseCase(h.uow, options(sink)).execute(h.input);
  if (mode === 'conflict') await expect(operation).rejects.toBeInstanceOf(IdempotencyConflictError);
  else expect((await operation).idempotentReplay).toBe(mode === 'replay');
  expect(h.inserted).toHaveLength(mode === 'retry' ? 1 : 0); expect(calls).toBe(1);
});

function consumer(sink?: Sink) {
  const actions: string[] = []; const diagnostics: ConsumerDiagnostic[] = [];
  const h = financial(); const result: ProcessWagerResult = { transactionId: randomUUID(), status: Status.Processed, balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false };
  const processor = { execute: async (_input: ProcessWagerInput) => result };
  const transport: SqsConsumerTransport = { receive: async () => undefined, acknowledge: async () => { actions.push('ack'); },
    retry: async () => { actions.push('retry'); }, deadLetter: async () => { actions.push('dlq'); } };
  const message = { body: JSON.stringify({ type: 'WagerTransactionRequested', messageId: 'logical-message', correlationId, occurredAt: at.toISOString(), data: h.input }),
    transportMessageId: 'transport-message', receiptHandle: 'SYNTHETIC_PRIVATE_RECEIPT', receiveCount: 1 };
  // Extra trailing options preserve the existing diagnose callback and its exact array.
  const instance = Reflect.construct(SqsWagerConsumer, [processor, transport, { now: () => at }, consumerConfig({}),
    (event: ConsumerDiagnostic) => diagnostics.push(event), { operationalLog: sink }]) as SqsWagerConsumer;
  return { instance, processor, transport, message, result, actions, diagnostics };
}
test.each(['ack', 'ack-failure', 'retry', 'dlq'] as const)('B06 SQS %s has distinct events and real identifiers', async mode => {
  const c = capture(); const h = consumer(c.sink);
  if (mode === 'ack-failure') h.transport.acknowledge = async () => { throw new Error('synthetic receipt'); };
  if (mode === 'retry') h.processor.execute = async () => { throw { code: '40001' }; };
  if (mode === 'dlq') h.processor.execute = async () => { throw new IdempotencyConflictError('SYNTHETIC_SECRET'); };
  const outcome = await h.instance.handle(h.message);
  expect(outcome.action).toBe(mode === 'ack' ? 'acked' : mode === 'dlq' ? 'dead-lettered' : 'retry');
  expect(h.actions).toEqual(mode === 'ack' ? ['ack'] : mode === 'dlq' ? ['dlq', 'ack'] : ['retry']);
  const expected = mode === 'ack' ? ['sqs_received', 'sqs_acked'] : mode === 'ack-failure' ? ['sqs_received', 'sqs_ack_failed', 'sqs_retry_scheduled']
    : mode === 'dlq' ? ['sqs_received', 'sqs_dead_lettered'] : ['sqs_received', 'sqs_retry_scheduled'];
  expect(c.events()).toEqual(expected);
  expect(c.records[0]).toMatchObject({ messageId: 'logical-message', sqsMessageId: 'transport-message', correlationId, receiveCount: 1 });
  for (const record of c.records) publicRecord(record);
  expect(JSON.stringify(c.records)).not.toContain('SYNTHETIC');
});
test.each(['ack', 'ack-failure', 'retry', 'dlq'] as const)('B03 throwing SQS sink preserves %s and legacy diagnostics', async mode => {
  let calls = 0; const h = consumer(() => { calls++; throw new Error('sink'); });
  if (mode === 'retry') h.processor.execute = async () => { throw { code: '40001' }; };
  if (mode === 'dlq') h.processor.execute = async () => { throw new IdempotencyConflictError('conflict'); };
  if (mode === 'ack-failure') h.transport.acknowledge = async () => { throw new Error('ack error'); };
  await h.instance.handle(h.message);
  expect(h.actions).toEqual(mode === 'ack' ? ['ack'] : mode === 'dlq' ? ['dlq', 'ack'] : ['retry']);
  expect(h.diagnostics.map(d => d.action)).toEqual(mode === 'ack' ? [] : [mode === 'dlq' ? 'dead-lettered' : 'retry']);
  expect(calls).toBeGreaterThan(0);
});

function publisher(sink?: Sink) {
  const eventId = randomUUID();
  const item = OutboxMessage.rehydrate({ id: eventId, aggregateId: randomUUID(), eventType: 'WalletBalanceChanged', occurredAt: at, attempts: 0, nextAttemptAt: at,
    payload: { eventId, eventType: 'WalletBalanceChanged', occurredAt: at.toISOString(), correlationId, data: { balance: { amount: '999.99', currency: 'BRL' } } } });
  const diagnostics: PublisherDiagnostic[] = []; const actions: string[] = []; let inUow = false;
  const store: Partial<FinancialStore> = { claimNextOutbox: async (workerId, leaseToken, _now, leaseUntil) => ({ message: item, workerId, leaseToken, leaseUntil }),
    completeOutbox: async () => { actions.push('confirm'); return true; }, failOutbox: async () => { actions.push('retry'); return true; } };
  const uow: FinancialUnitOfWork = { run: async work => { inUow = true; try { const value = await work(store as FinancialStore); actions.push('commit'); return value; } finally { inUow = false; } } };
  const transport = { publish: async () => { expect(inUow).toBe(false); actions.push('send'); } };
  const opts = { workerId: 'logging-test', diagnose: (event: PublisherDiagnostic) => diagnostics.push(event), operationalLog: sink };
  return { instance: new OutboxPublisher(uow, transport, { now: () => at }, workerConfig({}), opts), store, transport, actions, diagnostics, item };
}
test.each(['confirmed', 'confirmation-pending', 'retry', 'fenced'] as const)('B06 outbox %s separates send from confirmation', async mode => {
  const c = capture(); const h = publisher(c.sink);
  if (mode === 'confirmation-pending') h.store.completeOutbox = async () => { throw new Error('SQL SYNTHETIC_SECRET'); };
  if (mode === 'retry') h.transport.publish = async () => { throw new Error('SYNTHETIC_SECRET'); };
  if (mode === 'fenced') h.store.completeOutbox = async () => false;
  expect((await h.instance.publishNext()).action).toBe(mode === 'confirmed' ? 'published' : mode === 'retry' ? 'retry-scheduled' : mode === 'fenced' ? 'lease-lost' : 'confirmation-pending');
  const expected = mode === 'confirmed' ? ['outbox_sent', 'outbox_confirmed'] : mode === 'retry' ? ['outbox_retry_scheduled']
    : mode === 'fenced' ? ['outbox_sent', 'outbox_lease_lost'] : ['outbox_sent', 'outbox_confirmation_pending'];
  expect(c.events()).toEqual(expected);
  expect(c.records.at(-1)).toMatchObject({ eventId: h.item.id, correlationId });
  for (const record of c.records) publicRecord(record);
  expect(JSON.stringify(c.records)).not.toContain('999.99'); expect(JSON.stringify(c.records)).not.toContain('SYNTHETIC_SECRET');
});
test('B03 throwing publisher sink preserves send, confirmation and legacy diagnostics', async () => {
  let count = 0; const h = publisher(() => { count++; throw new Error('sink'); });
  expect((await h.instance.publishNext()).action).toBe('published');
  expect(h.actions).toEqual(['commit', 'send', 'confirm', 'commit']); expect(h.diagnostics).toHaveLength(1); expect(count).toBe(2);
});

test.each(['confirmation-pending', 'retry', 'fenced'] as const)('B03 throwing outbox sink preserves %s and original diagnosis', async mode => {
  let count = 0; const h = publisher(() => { count++; throw new Error('sink'); });
  if (mode === 'confirmation-pending') h.store.completeOutbox = async () => { throw new Error('original SQL failure'); };
  if (mode === 'retry') h.transport.publish = async () => { throw new Error('original send failure'); };
  if (mode === 'fenced') h.store.completeOutbox = async () => false;
  const result = await h.instance.publishNext();
  expect(result.action).toBe(mode === 'retry' ? 'retry-scheduled' : mode === 'fenced' ? 'lease-lost' : 'confirmation-pending');
  expect(h.diagnostics).toHaveLength(1);
  if (mode === 'confirmation-pending' || mode === 'fenced') expect(h.actions).not.toContain('retry');
  expect(count).toBe(mode === 'retry' ? 1 : 2);
});

test('B06 PASS existing: rejected UoW preserves original exception and never emits success', async () => {
  const h = financial(); const c = capture(); const error = new Error('original transaction failure');
  h.uow.run = async () => { throw error; };
  await expect(new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(h.input)).rejects.toBe(error);
  expect(c.records).toEqual([]); expect(h.inserted).toEqual([]);
});

test('B06 known 23505 can resolve a definitive conflict without logging candidate or key', async () => {
  const h = financial(); const tx = history(h, { money: { amount: '26.00', currency: 'BRL' } }); const c = capture();
  h.store.findIdentity = async () => [tx]; const real = h.uow.run; let attempt = 0;
  h.uow.run = async (work, isolation) => { if (++attempt === 1) throw { code: '23505', constraint: 'uq_wager_idempotency' }; return real(work, isolation); };
  await expect(new ProcessWagerTransactionUseCase(h.uow, options(c.sink)).execute(h.input)).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(h.outbox).toEqual([]); expect(c.events()).toEqual(['idempotency_conflict']);
  expect(c.records[0]).not.toHaveProperty('transactionId'); expect(JSON.stringify(c.records)).not.toContain(h.input.idempotencyKey);
});

function pending(sink?: Sink) {
  const h = financial('90.00');
  const base = { ...h.input, id: randomUUID(), kind: Kind.Refund, money: money('10.00'), payloadHash: 'a'.repeat(64), referenceExternalTransactionId: 'bet', createdAt: at };
  const tx = WagerTransaction.rehydrate({ ...base, status: Status.PendingReference, attempts: 0, nextRetryAt: at,
    expiresAt: new Date(at.getTime() + 86400000), recordedBalance: money('100.00') });
  const ref = WagerTransaction.rehydrate({ ...base, id: randomUUID(), kind: Kind.Bet, externalTransactionId: 'bet', idempotencyKey: 'bet-key',
    referenceExternalTransactionId: undefined, status: Status.Processed, processedAt: at, recordedBalance: money('90.00') });
  h.store.getWager = async id => id === tx.id ? tx : ref; h.store.findWager = async () => ref; h.store.updatePendingWager = async () => true;
  const opts = { now: () => at, diagnose: () => {}, operationalLog: sink };
  return { ...h, tx, ref, candidate: { id: tx.id, walletId: h.wallet.id },
    worker: new PendingReferenceWorker(h.uow, { now: () => at }, pendingReferencePolicy({}), opts) };
}
test.each(['processed', 'rejected', 'rescheduled'] as const)('B06 pending reference %s uses available identities only', async mode => {
  const c = capture(); const h = pending(c.sink);
  if (mode === 'rescheduled') h.store.findWager = async () => undefined;
  if (mode === 'rejected') h.store.isReversed = async () => true;
  expect((await h.worker.resolve(h.candidate)).action).toBe(mode);
  expect(c.events()).toEqual([mode === 'rescheduled' ? 'pending_reference_rescheduled' : 'pending_reference_resolved']);
  expect(c.records[0]).toMatchObject({ transactionId: h.tx.id, walletId: h.wallet.id });
  // The original HTTP/SQS correlation is not stored on WagerTransaction.
  expect(c.records[0]).not.toHaveProperty('correlationId');
});
test('B06 PASS existing: pending noop is silent and makes no financial artifact', async () => {
  const c = capture(); const h = pending(c.sink); h.store.getWager = async () => h.ref;
  expect((await h.worker.resolve(h.candidate)).action).toBe('noop'); expect(c.records).toEqual([]); expect(h.outbox).toEqual([]);
});

test.each(['legacy', 'structured', 'fallback'] as const)('B01/B06 reconciliation precedence: %s', async mode => {
  const h = financial(); const c = capture(); const legacy: unknown[] = [];
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const config = { ...(mode === 'legacy' ? { log: (record: unknown) => { legacy.push(record); } } : {}),
    ...(mode !== 'fallback' ? { operationalLog: c.sink } : {}) };
  const reconcile = new ReconcileWalletUseCase(h.uow, config);
  try {
    const result = await reconcile.execute(h.wallet.id, { correlationId });
    expect(result.consistent).toBe(false); expect(reconcile.divergenceObservations).toBe(1n); expect(h.calls).toEqual(['commit']);
    if (mode === 'legacy') { expect(legacy).toEqual([{ event: 'WalletReconciliationMismatch', walletId: h.wallet.id, correlationId }]); expect(c.records).toEqual([]); expect(warn).not.toHaveBeenCalled(); }
    else if (mode === 'structured') { expect(c.events()).toEqual(['reconciliation_divergence']); expect(c.records[0]).toMatchObject({ walletId: h.wallet.id, correlationId }); expect(warn).not.toHaveBeenCalled(); }
    else { expect(c.records).toEqual([]); expect(warn).toHaveBeenCalledTimes(1); expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({ event: 'WalletReconciliationMismatch', walletId: h.wallet.id, correlationId }); }
  } finally { warn.mockRestore(); }
});
test.each(['legacy', 'structured'] as const)('B03 reconciliation failing %s emitter cannot invoke another fallback', async mode => {
  const h = financial(); const warn = spyOn(console, 'warn').mockImplementation(() => {}); let selected = 0; let secondary = 0;
  const fail = () => { selected++; throw new Error('sink'); };
  const config = { ...(mode === 'legacy' ? { log: fail } : {}), operationalLog: mode === 'legacy' ? () => { secondary++; } : fail };
  const reconcile = new ReconcileWalletUseCase(h.uow, config);
  try { expect((await reconcile.execute(h.wallet.id)).consistent).toBe(false); expect(reconcile.divergenceObservations).toBe(1n);
    expect(selected).toBe(1); expect(secondary).toBe(0); expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

test('B04 synchronous sink reentry is bounded without recursive error emission', async () => {
  const nested: Array<Promise<unknown>> = []; let received = 0;
  let h!: ReturnType<typeof consumer>;
  h = consumer(record => {
    if (record['event'] === 'sqs_received') {
      received++;
      // A finite ceiling protects the RED runner itself; GREEN must suppress reentrant emission.
      if (received < 4) nested.push(h.instance.handle({ ...h.message, body: 'invalid-json' }));
    }
  });
  expect((await h.instance.handle(h.message)).action).toBe('acked');
  await Promise.all(nested);
  expect(received).toBe(1);
});

test('B04 sink serialization failure cannot replace committed financial result', async () => {
  const h = financial(); let count = 0;
  const sink: Sink = record => {
    count++;
    // A writer can fail while serializing: the emission boundary must isolate this too.
    JSON.stringify({ ...record, toJSON() { throw new Error('synthetic serialization failure'); } });
  };
  const result = await new ProcessWagerTransactionUseCase(h.uow, options(sink)).execute(h.input);
  expect(result.status).toBe(Status.Processed); expect(h.calls.at(-1)).toBe('commit'); expect(h.inserted).toHaveLength(1); expect(count).toBe(1);
});

test('B01/B02 HTTP operational_error uses real correlation and never serializes Error or request headers', () => {
  const c = capture(); let status: number | undefined; let body: unknown; const headers: Record<string, string> = {};
  const response = { status(value: number) { status = value; return { json(value: unknown) { body = value; } }; },
    setHeader(key: string, value: string) { headers[key] = value; } };
  const host = { switchToHttp: () => ({ getResponse: () => response,
    getRequest: () => ({ correlationId, headers: { authorization: 'Bearer SYNTHETIC_PRIVATE' }, body: { amount: '999.99' } }) }) } as unknown as ArgumentsHost;
  const filter = Reflect.construct(HttpExceptionFilter, [{ operationalLog: c.sink }]) as HttpExceptionFilter;
  filter.catch(new Error('postgres://SYNTHETIC_PRIVATE@host/db'), host);
  expect(status).toBe(500); expect(body).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
  expect(headers['x-correlation-id']).toBe(correlationId);
  expect(c.events()).toEqual(['operational_error']); expect(c.records[0]).toMatchObject({ correlationId, code: 'INTERNAL_SERVER_ERROR' });
  publicRecord(c.records[0]!); expect(JSON.stringify(c.records)).not.toContain('SYNTHETIC_PRIVATE'); expect(JSON.stringify(c.records)).not.toContain('999.99');
});

// GREEN additions: the 60 unit RED tests above are kept unchanged.
test('B01 shared catalogue is exactly the homologated catalogue', () => {
  expect(new Set<string>(operationalEvents)).toEqual(catalogue); expect(operationalEvents).toHaveLength(20);
});
test.each(['unknown', 'started', 'Bearer SYNTHETIC_TOKEN', 'wallet_created\nforged'])('B01/B02 reject unrecognized event literal %#', event => {
  const c = capture(); operationalEmitter(c.sink)({ component: 'wallets', event }); expect(c.records).toEqual([]);
});
test('B02 adapter projects fields and values even when called directly', () => {
  const lines: string[] = []; const write = structuredLogger(line => { lines.push(line); });
  write({ component: 'wallets', event: 'wallet_created', phase: 'ready', action: 'started', code: 'SELECT private',
    correlationId: 'Bearer SYNTHETIC_TOKEN', walletId: 'invalid', status: 'SYNTHETIC_PRIVATE', providerId: 'postgres://synthetic:secret@host/db',
    playerId: 'SYNTHETIC_PRIVATE', payload: { amount: '999.99' }, error: new Error('SYNTHETIC_PRIVATE') } as unknown as Parameters<typeof write>[0]);
  expect(lines).toHaveLength(1); expect(lines[0]!.split('\n')).toHaveLength(2); expect(lines[0]!.endsWith('\n')).toBe(true);
  const record = JSON.parse(lines[0]!) as RecordLine; publicRecord(record);
  expect(Object.keys(record).sort()).toEqual(['component', 'event', 'level', 'timestamp']);
  for (const value of ['SYNTHETIC', '999.99', 'SELECT', 'postgres://', 'started', 'ready']) expect(lines[0]).not.toContain(value);
});
test('B02 getters, toJSON and arbitrary objects are not invoked by projection', () => {
  let reads = 0;
  const input = { event: 'wallet_created', component: 'wallets', get correlationId() { reads++; throw new Error('getter'); },
    toJSON() { reads++; throw new Error('toJSON'); }, providerId: { toString() { reads++; return 'secret'; } } };
  expect(projectOperationalRecord(input)).toMatchObject({ event: 'wallet_created', component: 'wallets' }); expect(reads).toBe(0);
});
test('B04 throwing proxy is isolated and does not poison later emissions', () => {
  const c = capture(); const emit = operationalEmitter(c.sink);
  emit(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('projection'); } }));
  emit({ component: 'wallets', event: 'wallet_created' }); expect(c.events()).toEqual(['wallet_created']);
});
test('B04 unresolved sink has at most one pending call, with no retry queue', async () => {
  let count = 0; let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const emit = operationalEmitter(() => { count++; return pending; });
  for (let i = 0; i < 10000; i++) emit({ component: 'wallets', event: 'wallet_created' });
  expect(count).toBe(1); release(); await nextTurn();
  expect(count).toBe(1); emit({ component: 'wallets', event: 'wallet_created' }); expect(count).toBe(2);
});
test.each(faults)('B03/B04 adapter writer is also isolated: %s', async (_name, fault) => {
  let count = 0; const unhandled: unknown[] = []; const listener = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  try {
    const sink = structuredLogger(() => { count++; return fault(); });
    expect(() => sink({ component: 'wallets', event: 'wallet_created' })).not.toThrow();
    await nextTurn(); expect(count).toBe(1); expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', listener); }
});
test('B04 synchronous reentrancy is shared by wrappers for the same sink', () => {
  let count = 0; let nested!: ReturnType<typeof operationalEmitter>;
  const sink: Sink = () => { count++; if (count < 4) nested({ component: 'wallets', event: 'wallet_created' }); };
  nested = operationalEmitter(sink); operationalEmitter(sink)({ component: 'wallets', event: 'wallet_created' }); expect(count).toBe(1);
});
test('B01 numeric and boolean fields never coerce strings, nonfinite or monetary values', () => {
  const record = projectOperationalRecord({ component: 'wallets', event: 'wallet_created', receiveCount: '1', durationMs: Infinity,
    idempotentReplay: 'true', correlationId: '100.00', walletId: randomUUID(), providerId: 'provider-a' });
  expect(record).not.toHaveProperty('receiveCount'); expect(record).not.toHaveProperty('durationMs');
  expect(record).not.toHaveProperty('idempotentReplay'); expect(record).not.toHaveProperty('correlationId');
  expect(record).toHaveProperty('providerId', 'provider-a');
});
test.each([400, 404, 409, 422])('B06 filter does not duplicate client or financial outcome %s', status => {
  const c = capture(); const host = { switchToHttp: () => ({ getResponse: () => ({ setHeader() {}, status: () => ({ json() {} }) }),
    getRequest: () => ({ correlationId }) }) } as unknown as ArgumentsHost;
  const { HttpException } = require('@nestjs/common') as typeof import('@nestjs/common');
  new HttpExceptionFilter({ operationalLog: c.sink }).catch(new HttpException('SYNTHETIC_PRIVATE', status), host);
  expect(c.records).toEqual([]);
});

import 'reflect-metadata';
import { NestFactory, ModulesContainer } from '@nestjs/core';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { AppModule } from '../../src/app.module';
import { FINANCIAL_UNIT_OF_WORK } from '../../src/shared/application/financial-store';

test('B01/B06 HTTP composition explicitly connects sinks without ORM, extra UoW or workers', async () => {
  const h = financial(); const lines: string[] = [];
  const write = spyOn(Bun, 'write').mockImplementation(async (_destination, data) => { const line = String(data); lines.push(line); return Buffer.byteLength(line); });
  const app = await NestFactory.create(AppModule.register({ uow: h.uow }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1'); const url = await app.getUrl();
    const wallet = await fetch(`${url}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'test-player', initialBalance: { amount: '0.00', currency: 'BRL' } }) });
    expect(wallet.status).toBe(201);
    const wager = await fetch(`${url}/wagering/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': h.input.idempotencyKey },
      body: JSON.stringify({ providerId: h.input.providerId, externalTransactionId: h.input.externalTransactionId, walletId: h.input.walletId,
        playerId: h.input.playerId, roundId: h.input.roundId, gameId: h.input.gameId, kind: h.input.kind, money: h.input.money }) });
    expect(wager.status).toBe(200);
    h.store.getWallet = async () => { throw new Error('postgres://SYNTHETIC_PRIVATE'); };
    const failure = await fetch(`${url}/wallets/${h.wallet.id}`);
    expect(failure.status).toBe(500); expect(await failure.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
    await nextTurn();
    const records = lines.map(line => JSON.parse(line) as RecordLine);
    expect(records.map(record => record['event'])).toEqual(['wallet_created', 'wager_processed', 'operational_error']);
    expect(records.map(record => record['correlationId'])).toEqual([wallet.headers.get('x-correlation-id'), wager.headers.get('x-correlation-id'), failure.headers.get('x-correlation-id')]);
    expect(lines.join('')).not.toContain('SYNTHETIC_PRIVATE');
    const modules = [...app.get(ModulesContainer).values()]; const providers = modules.flatMap(m => [...m.providers.entries()]);
    expect(modules.filter(m => m.metatype.name === 'DatabaseModule')).toHaveLength(1);
    expect(providers.filter(([token]) => token === CoreORM)).toHaveLength(0);
    expect(providers.filter(([token]) => token === FINANCIAL_UNIT_OF_WORK).map(([, p]) => p.instance)).toEqual([h.uow]);
    expect(providers.filter(([, p]) => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(p.metatype?.name ?? ''))).toHaveLength(0);
  } finally { await app.close(); write.mockRestore(); }
});

test.each(['AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature', 'token:SYNTHETIC_PRIVATE'])('B02 recognizable credential sample %# is omitted from allowed identifiers', value => {
  const record = projectOperationalRecord({ component: 'wallets', event: 'wallet_created', correlationId: value, providerId: value });
  expect(record).not.toHaveProperty('correlationId'); expect(record).not.toHaveProperty('providerId'); expect(JSON.stringify(record)).not.toContain(value);
});

test.each(faults)('B03/B04 selected legacy reconciliation logger is isolated without fallback: %s', async (_name, fault) => {
  const h = financial(); let selected = 0; const c = capture(); const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection', listener);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reconcile = new ReconcileWalletUseCase(h.uow, { log: () => { selected++; return fault(); }, operationalLog: c.sink });
    expect((await reconcile.execute(h.wallet.id, { correlationId })).consistent).toBe(false);
    await nextTurn(); expect(reconcile.divergenceObservations).toBe(1n); expect(selected).toBe(1);
    expect(c.records).toEqual([]); expect(warn).not.toHaveBeenCalled(); expect(unhandled).toEqual([]);
  } finally { warn.mockRestore(); process.off('unhandledRejection', listener); }
});

// Corrective RED: CP05B-REV-06/07. Previous tests remain byte-for-byte intact.
test('REV06 RED consecutive records survive a Promise writer in the same turn, in order', async () => {
  const lines: string[] = [];
  const logger = structuredLogger(line => { lines.push(line); return Promise.resolve(Buffer.byteLength(line)); });
  logger({ component: 'wallets', event: 'wallet_created', walletId: randomUUID() });
  logger({ component: 'http', event: 'operational_error', code: 'INTERNAL_SERVER_ERROR' });
  await nextTurn();
  expect(lines.map(line => JSON.parse(line).event)).toEqual(['wallet_created', 'operational_error']);
  for (const line of lines) { expect(line.endsWith('\n')).toBe(true); expect(line.split('\n')).toHaveLength(2); publicRecord(JSON.parse(line) as RecordLine); }
});

test('REV06 RED concurrent callers preserve both records before a deferred writer settles', async () => {
  const lines: string[] = []; let release!: () => void;
  const receipt = new Promise<void>(resolve => { release = resolve; });
  const logger = structuredLogger(line => { lines.push(line); return receipt; });
  try {
    await Promise.all([
      Promise.resolve().then(() => logger({ component: 'wallets', event: 'wallet_created' })),
      Promise.resolve().then(() => logger({ component: 'wagering', event: 'wager_processed' })),
    ]);
  } finally { release(); await nextTurn(); }
  expect(lines.map(line => JSON.parse(line).event)).toEqual(['wallet_created', 'wager_processed']);
});

test('REV06 RED legitimate consecutive call is preserved while synchronous reentry is rejected', async () => {
  const lines: string[] = []; let logger!: ReturnType<typeof structuredLogger>;
  logger = structuredLogger(line => {
    lines.push(line);
    // Ceiling prevents a defective implementation from recursing forever in the test itself.
    if (lines.length < 4) logger({ component: 'wallets', event: 'reconciliation_divergence' });
    return Promise.resolve();
  });
  logger({ component: 'wallets', event: 'wallet_created' });
  logger({ component: 'wagering', event: 'wager_processed' });
  await nextTurn();
  expect(lines.map(line => JSON.parse(line).event)).toEqual(['wallet_created', 'wager_processed']);
});

test.each(faults)('REV06 corrective writer isolation retains two external calls: %s', async (_name, fault) => {
  const lines: string[] = []; const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection', listener);
  try {
    const logger = structuredLogger(line => { lines.push(line); return fault(); });
    expect(() => logger({ component: 'wallets', event: 'wallet_created' })).not.toThrow();
    expect(() => logger({ component: 'wagering', event: 'wager_processed' })).not.toThrow();
    await nextTurn();
    expect(unhandled).toEqual([]);
    expect(lines.map(line => JSON.parse(line).event)).toEqual(['wallet_created', 'wager_processed']);
  } finally { process.off('unhandledRejection', listener); }
});

test('REV06 RED pending writes cannot stall financial results or erase one of two committed observations', async () => {
  const h = financial(); const lines: string[] = []; let release!: () => void;
  const receipt = new Promise<void>(resolve => { release = resolve; });
  const logger = structuredLogger(line => { lines.push(line); return receipt; });
  let settled = false; let wallets: Wallet[] = [];
  const create = new CreateWalletUseCase(h.uow, { now: () => at, operationalLog: logger });
  const operation = Promise.all(['one', 'two'].map(playerId => create.execute({ playerId,
    initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId }))).then(result => { wallets = result; settled = true; });
  try {
    await nextTurn();
    expect(settled).toBe(true); // Never await an unresolved sink on the financial path.
    expect(wallets).toHaveLength(2); expect(new Set(wallets.map(wallet => wallet.id)).size).toBe(2);
    expect(wallets.map(wallet => wallet.balance.toString())).toEqual(['0.00', '0.00']);
    expect(h.calls.filter(call => call === 'wallet-insert')).toHaveLength(2);
    expect(h.calls.filter(call => call === 'commit')).toHaveLength(2); expect(h.outbox).toEqual([]);
  } finally { release(); await operation; await nextTurn(); }
  const records = lines.map(line => JSON.parse(line) as RecordLine);
  expect(records.map(record => record['event'])).toEqual(['wallet_created', 'wallet_created']);
  expect(records.map(record => record['walletId'])).toEqual(wallets.map(wallet => wallet.id));
});

test('REV07 RED unmapped HttpException 500 emits HTTP_ERROR without its sensitive message', () => {
  const c = capture(); let status: number | undefined; let body: unknown;
  const host = { switchToHttp: () => ({ getResponse: () => ({ setHeader() {}, status(value: number) {
    status = value; return { json(value: unknown) { body = value; } };
  } }), getRequest: () => ({ correlationId }) }) } as unknown as ArgumentsHost;
  const { HttpException } = require('@nestjs/common') as typeof import('@nestjs/common');
  new HttpExceptionFilter({ operationalLog: c.sink }).catch(new HttpException('SYNTHETIC_HTTP_SECRET postgres://private:password@host/db', 500), host);
  expect(status).toBe(500); expect(body).toEqual({ code: 'HTTP_ERROR', message: 'HTTP request failed' });
  expect(c.events()).toEqual(['operational_error']); expect(c.records[0]?.['correlationId']).toBe(correlationId);
  expect(JSON.stringify(c.records)).not.toContain('SYNTHETIC_HTTP_SECRET'); expect(JSON.stringify(c.records)).not.toContain('postgres://');
  expect(c.records[0]?.['code']).toBe('HTTP_ERROR');
});
