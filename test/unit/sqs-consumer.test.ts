import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { consumerConfig, consumerRetrySeconds } from '../../src/modules/messaging/application/consumer-config';
import { classifyConsumerError } from '../../src/modules/messaging/application/consumer-errors';
import { SqsWagerConsumer, type ConsumerDiagnostic, type WagerProcessor } from '../../src/modules/messaging/application/sqs-wager-consumer';
import type { ReceivedWagerMessage, SqsConsumerTransport } from '../../src/modules/messaging/application/sqs-transport';
import { wagerRequest } from '../../src/modules/messaging/application/wager-request';
import { canonicalWagerPayload } from '../../src/modules/wagering/application/wager-payload';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { IdempotencyConflictError, InvalidDomainInputError, InvalidMoneyError, MoneyOverflowError } from '../../src/shared/domain/domain-errors';
import { NotFoundError, PersistenceInvariantError, RetryExhaustedError } from '../../src/shared/application/application-errors';
import type { ProcessWagerResult } from '../../src/modules/wagering/application/process-wager-transaction.use-case';

const now = new Date('2026-11-04T10:00:00.000Z');
const clock = { now: () => new Date(now) };
const config = consumerConfig({});
const result: ProcessWagerResult = { transactionId: randomUUID(), status: WagerTransactionStatus.Processed,
  balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false };
function body() {
  return { type: 'WagerTransactionRequested', messageId: 'envelope-id', occurredAt: now.toISOString(),
    data: { providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'business-key',
      playerId: 'player-test-01', walletId: randomUUID(), roundId: 'round', gameId: 'game', kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' } } };
}
function harness(processor: WagerProcessor = { execute: async () => result }) {
  const actions: string[] = []; const diagnostics: ConsumerDiagnostic[] = [];
  const sent: { body: string; group: string; dedup: string }[] = [];
  const receipts: string[] = []; const delays: number[] = [];
  const transport: SqsConsumerTransport = { receive: async () => undefined,
    acknowledge: async receipt => { actions.push('ack'); receipts.push(receipt); },
    retry: async (_receipt, delay) => { actions.push('retry'); delays.push(delay); },
    deadLetter: async (body, group, dedup) => { actions.push('dlq'); sent.push({ body, group, dedup }); } };
  const consumer = new SqsWagerConsumer(processor, transport, clock, config, e => diagnostics.push(e));
  const message: ReceivedWagerMessage = { body: JSON.stringify(body()), transportMessageId: 'sqs-id', receiptHandle: 'ephemeral-receipt', receiveCount: 1 };
  return { consumer, transport, message, actions, diagnostics, sent, receipts, delays };
}

test('ACK waits for processor commit; envelope identity, key and receipt are kept distinct', async () => {
  let finish!: (value: ProcessWagerResult) => void;
  let seen: Parameters<WagerProcessor['execute']>[0] | undefined;
  const commit = new Promise<ProcessWagerResult>(resolve => { finish = resolve; });
  const h = harness({ execute: async input => { seen = input; return commit; } });
  const pending = h.consumer.handle(h.message);
  await Promise.resolve();
  expect(h.actions).toEqual([]);
  expect(seen?.inbox?.messageId).toBe('envelope-id');
  expect(seen?.inbox?.consumerName).toBe(config.consumerName);
  expect(seen?.idempotencyKey).toBe('business-key');
  expect(seen?.causationId).toBe('envelope-id');
  expect(seen?.inbox?.receivedAt).toEqual(now);
  finish(result);
  expect((await pending).action).toBe('acked');
  expect(h.receipts).toEqual(['ephemeral-receipt']);
});
test.each([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.PendingReference, WagerTransactionStatus.Failed])('persisted result %s ACKs without DLQ', async status => {
  const h = harness({ execute: async () => ({ ...result, status }) });
  expect((await h.consumer.handle(h.message)).action).toBe('acked');
  expect(h.actions).toEqual(['ack']);
});
test('financial replay ACKs and keeps the historical result', async () => {
  const h = harness({ execute: async () => ({ ...result, idempotentReplay: true }) });
  const outcome = await h.consumer.handle(h.message);
  expect(outcome.action).toBe('acked');
  if (outcome.action === 'acked') expect(outcome.result).toEqual({ ...result, idempotentReplay: true });
});
test('JSON invalid goes to FIFO DLQ first and has stable dedup without raw body or exception', async () => {
  const h = harness({ execute: async () => { throw new Error('processor must not execute'); } });
  const message = { ...h.message, body: '{invalid secret-value' };
  expect((await h.consumer.handle(message)).action).toBe('dead-lettered');
  expect(h.actions).toEqual(['dlq', 'ack']);
  const dead = JSON.parse(h.sent[0]!.body) as Record<string, unknown>;
  expect(dead['errorCode']).toBe('INVALID_INPUT');
  expect(dead['sourceMessageId']).toBe('sqs-id');
  expect(dead['bodyHash']).toMatch(/^[a-f0-9]{64}$/);
  expect(h.sent[0]!.body).not.toContain('secret-value');
  expect(h.sent[0]!.group).toMatch(/^dlq-[a-f0-9]{32}$/);
  await h.consumer.handle({ ...message, receiveCount: 2, receiptHandle: 'new-receipt' });
  expect(h.sent[1]!.dedup).toBe(h.sent[0]!.dedup);
  expect(h.sent[1]!.group).toBe(h.sent[0]!.group);
});
test('failed DLQ send never ACKs the source', async () => {
  const h = harness(); h.transport.deadLetter = async () => { throw new Error('network'); };
  expect(await h.consumer.handle({ ...h.message, body: 'bad' })).toEqual({ action: 'retry', code: 'DLQ_SEND_FAILED' });
  expect(h.actions).toEqual(['retry']);
});
test('DLQ success then ACK failure remains a retry', async () => {
  const h = harness(); h.transport.acknowledge = async () => { throw new Error('lost receipt'); };
  expect(await h.consumer.handle({ ...h.message, body: 'bad' })).toEqual({ action: 'retry', code: 'DLQ_ACK_FAILED' });
  expect(h.actions).toEqual(['dlq', 'retry']);
});
test('ACK failure after financial success never sends financial operation to DLQ', async () => {
  const h = harness(); h.transport.acknowledge = async () => { throw new InvalidDomainInputError('ack failure'); };
  expect(await h.consumer.handle(h.message)).toEqual({ action: 'retry', code: 'ACK_FAILED' });
  expect(h.actions).toEqual(['retry']);
});
test.each([
  [new IdempotencyConflictError('x'), 'IDEMPOTENCY_CONFLICT'], [new InvalidDomainInputError('x'), 'INVALID_INPUT'],
  [new InvalidMoneyError('x'), 'INVALID_MONEY'], [new MoneyOverflowError('x'), 'MONEY_OVERFLOW'], [new NotFoundError('x'), 'WALLET_NOT_FOUND'],
] as const)('known permanent errors get stable diagnostic codes', async (error, code) => {
  expect(classifyConsumerError(error)).toEqual({ kind: 'permanent', code });
  const h = harness({ execute: async () => { throw error; } });
  expect(await h.consumer.handle(h.message)).toEqual({ action: 'dead-lettered', code });
  expect(h.actions).toEqual(['dlq', 'ack']);
});
test.each(['40P01', '40001', '55P03', '57014', '08006', '57P01', '53300', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'])('transient %s retries with bounded visibility and no ACK', async code => {
  const h = harness({ execute: async () => { throw Object.assign(new Error('credential-must-not-log'), { code }); } });
  expect((await h.consumer.handle({ ...h.message, receiveCount: 1000 })).action).toBe('retry');
  expect(h.actions).toEqual(['retry']);
  expect(h.delays).toEqual([config.retryMaxSeconds]);
  expect(JSON.stringify(h.diagnostics)).not.toContain('credential-must-not-log');
});
test('wrapped exhausted PostgreSQL retry is transient; arbitrary SQL failure stays unknown', () => {
  expect(classifyConsumerError(new RetryExhaustedError('x', { cause: { code: '40P01' } })).kind).toBe('transient');
  expect(classifyConsumerError({ code: '23514' }).kind).toBe('unknown');
  expect(classifyConsumerError(new PersistenceInvariantError('x')).kind).toBe('unknown');
  expect(classifyConsumerError({ name: 'TimeoutError' })).toEqual({ kind: 'transient', code: 'TIMEOUT' });
  expect(classifyConsumerError({ $metadata: { httpStatusCode: 503 } }).kind).toBe('transient');
});
test.each([1, config.maxReceiveCount, config.maxReceiveCount + 1, 1000])('unknown receive %s preserves original envelope for native redrive without manual deletion', async receiveCount => {
  const cause = new Error('Connection terminated unexpectedly'); // pg emits this without code.
  const error = new RetryExhaustedError('unknown-secret', { cause });
  const h = harness({ execute: async () => { throw error; } });
  let sourceBody: string | undefined = h.message.body;
  const acknowledge = h.transport.acknowledge;
  h.transport.acknowledge = async receipt => { sourceBody = undefined; await acknowledge(receipt); };
  expect(classifyConsumerError(error)).toEqual({ kind: 'unknown', code: 'UNKNOWN_ERROR' });
  const outcome = await h.consumer.handle({ ...h.message, receiveCount });
  // Direct loss regression: the old manual diagnostic + DeleteMessage removed the only original.
  expect(sourceBody === h.message.body).toBe(true); // Do not dump the envelope on failure.
  expect(h.sent).toEqual([]);
  expect(h.receipts).toEqual([]);
  expect(h.actions).toEqual(['retry']);
  expect(outcome).toEqual({ action: 'retry', code: 'UNKNOWN_ERROR' });
  expect(error.cause).toBe(cause);
  expect(cause.message).toBe('Connection terminated unexpectedly');
  expect('code' in cause).toBe(false);
  expect(JSON.stringify(h.diagnostics)).not.toContain('unknown-secret');
  expect(JSON.stringify(h.diagnostics)).not.toContain(h.message.body);
});
test('visibility/diagnostic failures never trigger ACK', async () => {
  const h = harness({ execute: async () => { throw { code: 'ECONNRESET' }; } });
  h.transport.retry = async () => { throw new Error('cannot change visibility'); };
  expect((await h.consumer.handle(h.message)).action).toBe('retry');
  expect(h.receipts).toEqual([]);
  expect(h.diagnostics.at(-1)?.code).toBe('VISIBILITY_FAILED');
  const c = new SqsWagerConsumer({ execute: async () => result }, h.transport, clock, config, () => { throw new Error('logging'); });
  expect((await c.handle(h.message)).action).toBe('acked');
});
test('canonical business input excludes transport fields and normalizes absent reference', () => {
  const message = body();
  const a = wagerRequest(JSON.stringify(message), config.consumerName, clock);
  const b = wagerRequest(JSON.stringify({ ...message, messageId: 'different', occurredAt: '2026-11-04T12:00:00+02:00',
    correlationId: 'different-correlation', data: { ...message.data, referenceExternalTransactionId: null } }), config.consumerName, clock);
  expect(canonicalWagerPayload(a)).toBe(canonicalWagerPayload(b));
  expect(a.correlationId).toBe('envelope-id');
  expect(b.correlationId).toBe('different-correlation');
  expect(a.playerId).toBe('player-test-01');
});
test.each(['not-date', '2026-02-30T00:00:00Z', '2026-11-04', '2026-11-04T25:00:00Z'])('reject invalid envelope date %s', occurredAt => {
  expect(() => wagerRequest(JSON.stringify({ ...body(), occurredAt }), config.consumerName, clock)).toThrow(InvalidDomainInputError);
});
test('reject envelope shape and external OPENING; reference remains subject to domain rules', () => {
  for (const value of [null, [], 'text', {}, { ...body(), data: null }, { ...body(), type: 'Other' }, { ...body(), messageId: '' }]) {
    expect(() => wagerRequest(JSON.stringify(value), config.consumerName, clock)).toThrow(InvalidDomainInputError);
  }
  const message = body();
  expect(() => wagerRequest(JSON.stringify({ ...message, data: { ...message.data, kind: 'OPENING' } }), config.consumerName, clock)).toThrow();
  expect(() => wagerRequest(JSON.stringify({ ...message, data: { ...message.data, money: { amount: '-1.00', currency: 'BRL' } } }), config.consumerName, clock)).toThrow(InvalidMoneyError);
});
test('consumer settings are validated and backoff is capped', () => {
  expect(consumerRetrySeconds(1, config)).toBe(1);
  expect(consumerRetrySeconds(3, config)).toBe(4);
  expect(consumerRetrySeconds(1000, config)).toBe(60);
  for (const env of [{ SQS_WAIT_SECONDS: '21' }, { SQS_VISIBILITY_TIMEOUT_SECONDS: '0' }, { SQS_RETRY_BASE_SECONDS: 'NaN' },
    { SQS_MAX_RECEIVE_COUNT: '0' }, { SQS_RETRY_BASE_SECONDS: '61' }, { SQS_CONSUMER_NAME: '' }]) expect(() => consumerConfig(env)).toThrow();
});
test('cancelled poll releases a received receipt and does not execute a new transaction', async () => {
  const controller = new AbortController(); const h = harness({ execute: async () => { throw new Error('must not execute'); } });
  h.transport.receive = async () => { controller.abort(); return h.message; };
  expect(await h.consumer.pollOnce(controller.signal)).toEqual({ action: 'retry', code: 'POLL_CANCELLED' });
  expect(h.delays).toEqual([0]);
  expect(h.receipts).toEqual([]);
});

test('unexpected PENDING result is retried without acknowledging an uncommitted operation', async () => {
  const h = harness({ execute: async () => ({ ...result, status: WagerTransactionStatus.Pending }) });
  expect(await h.consumer.handle(h.message)).toEqual({ action: 'retry', code: 'UNKNOWN_ERROR' });
  expect(h.receipts).toEqual([]);
});
test('aborting an idle long poll stops the consumer without processing or acknowledging messages', async () => {
  const h = harness(); const controller = new AbortController();
  let receiving!: () => void; const entered = new Promise<void>(r => { receiving = r; });
  h.transport.receive = signal => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted receive')), { once: true }); receiving();
  });
  const loop = h.consumer.run(controller.signal);
  await entered; controller.abort(); await loop;
  expect(h.actions).toEqual([]);
});

test('shutdown after a settled transient failure releases receipt immediately without ACK', async () => {
  const controller = new AbortController();
  const h = harness({ execute: async () => { controller.abort(); throw { code: 'ECONNRESET' }; } });
  expect((await h.consumer.handle(h.message, controller.signal)).action).toBe('retry');
  expect(h.delays).toEqual([0]); expect(h.receipts).toEqual([]);
});
