import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FinancialStore, FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import { OutboxPublisher, type OutboxTransport, type PublisherDiagnostic } from '../../src/modules/messaging/application/outbox-publisher';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { outboxSendInput } from '../../src/modules/messaging/infrastructure/aws-sqs-outbox-transport';

const at = new Date('2035-01-01T00:00:00Z');
function message(attempts = 0) {
  const id = randomUUID(); const aggregateId = randomUUID();
  return OutboxMessage.rehydrate({ id, aggregateId, eventType: 'WalletBalanceChanged', occurredAt: at, attempts,
    nextAttemptAt: at, payload: { eventId: id, aggregateId, eventType: 'WalletBalanceChanged', version: 1,
      occurredAt: at.toISOString(), correlationId: 'correlation', data: { balance: { amount: '100.00', currency: 'BRL' } } } });
}
function harness(config = workerConfig({})) {
  const item = message(); const owner = 'publisher-unit'; const token = randomUUID();
  let now = new Date(at); let inTransaction = false;
  const actions: string[] = []; const diagnostics: PublisherDiagnostic[] = [];
  let claimPresent = true;
  const store: Pick<FinancialStore, 'claimNextOutbox' | 'completeOutbox' | 'failOutbox'> = {
    claimNextOutbox: async (workerId, leaseToken, claimAt, until, retry) => {
      expect(inTransaction).toBe(true); expect(workerId).toBe(owner); expect(leaseToken).toBe(token);
      expect(claimAt).toEqual(at); expect(until.getTime() - claimAt.getTime()).toBe(config.outboxLeaseMs);
      expect(retry).toEqual({ baseDelayMs: config.outboxBaseRetryMs, maxDelayMs: config.outboxMaxRetryMs });
      actions.push('claim'); if (!claimPresent) return undefined;
      return { message: item, workerId, leaseToken, leaseUntil: until };
    },
    completeOutbox: async (id, workerId, leaseToken, publishedAt) => {
      expect(inTransaction).toBe(true); expect(id).toBe(item.id); expect(workerId).toBe(owner); expect(leaseToken).toBe(token);
      expect(publishedAt).toEqual(now); actions.push('complete'); return true;
    },
    failOutbox: async (retried, workerId, leaseToken, failedAt, errorCode) => {
      expect(inTransaction).toBe(true); expect(retried.id).toBe(item.id); expect(retried.attempts).toBe(1);
      expect(workerId).toBe(owner); expect(leaseToken).toBe(token); expect(failedAt).toEqual(now);
      expect(errorCode).toMatch(/^SQS_SEND_(FAILED|TIMEOUT)$/); actions.push('fail'); return true;
    },
  };
  const uow: FinancialUnitOfWork = { run: async work => {
    expect(inTransaction).toBe(false); inTransaction = true;
    try { const result = await work(store as FinancialStore); actions.push('commit'); return result; }
    finally { inTransaction = false; }
  } };
  const transport: OutboxTransport = { publish: async (sent, signal) => {
    expect(inTransaction).toBe(false); expect(sent).toBe(item); expect(signal.aborted).toBe(false); actions.push('send');
  } };
  const publisher = new OutboxPublisher(uow, transport, { now: () => new Date(now) }, config,
    { workerId: owner, newToken: () => token, diagnose: event => diagnostics.push(event) });
  return { item, store, uow, transport, publisher, actions, diagnostics, setNow: (date: Date) => { now = date; },
    idle: () => { claimPresent = false; } };
}
test('single-event claim commits before SQS; confirmation is a separate transaction', async () => {
  const h = harness(); expect(await h.publisher.publishNext()).toEqual({ action: 'published', eventId: h.item.id });
  expect(h.actions).toEqual(['claim', 'commit', 'send', 'complete', 'commit']);
});
test('empty Outbox does not publish or confirm', async () => {
  const h = harness(); h.idle(); expect(await h.publisher.publishNext()).toEqual({ action: 'idle' });
  expect(h.actions).toEqual(['claim', 'commit']);
});
test('claim rollback prevents SQS send', async () => {
  const h = harness(); h.store.claimNextOutbox = async () => { throw new Error('claim failed'); };
  await expect(h.publisher.publishNext()).rejects.toThrow('claim failed'); expect(h.actions).toEqual([]);
});
test('each attempt uses a fresh claim token, independent of the stable event ID', async () => {
  const h = harness(); const seen: string[] = [];
  h.store.claimNextOutbox = async (owner, token, _at, until) => {
    seen.push(token); return { message: h.item, workerId: owner, leaseToken: token, leaseUntil: until };
  };
  h.store.completeOutbox = async () => true;
  const p = new OutboxPublisher(h.uow, h.transport, { now: () => at }, workerConfig({}), { workerId: 'owner', diagnose: () => {} });
  await p.publishNext(); await p.publishNext();
  expect(seen[0]).not.toBe(seen[1]); expect(seen.every(t => /^[a-f0-9-]{36}$/.test(t))).toBe(true);
});
test('insufficient remaining lease skips publish and leaves recovery to expiration', async () => {
  const h = harness(); const original = h.store.claimNextOutbox;
  h.store.claimNextOutbox = async (...args) => { const c = await original(...args); h.setNow(new Date(at.getTime() + 6500)); return c; };
  expect((await h.publisher.publishNext()).action).toBe('lease-lost'); expect(h.actions).toEqual(['claim', 'commit']);
});
test('failed send schedules retry with fencing and preserves envelope/ID', async () => {
  const h = harness(); const before = JSON.stringify(h.item.payload);
  h.transport.publish = async () => { h.actions.push('send'); throw new Error('do-not-log-credential'); };
  expect(await h.publisher.publishNext()).toEqual({ action: 'retry-scheduled', eventId: h.item.id });
  expect(h.actions).toEqual(['claim', 'commit', 'send', 'fail', 'commit']);
  expect(h.item.nextAttemptAt.getTime() - at.getTime()).toBe(1000);
  expect(JSON.stringify(h.item.payload)).toBe(before);
  expect(JSON.stringify(h.diagnostics)).not.toContain('do-not-log-credential');
});
test('timeout after accepted send remains retryable and never confirms published_at', async () => {
  const h = harness();
  h.transport.publish = async () => { h.actions.push('accepted'); const e = new Error('unknown send outcome'); e.name = 'TimeoutError'; throw e; };
  expect((await h.publisher.publishNext()).action).toBe('retry-scheduled');
  expect(h.actions).not.toContain('complete'); expect(h.diagnostics[0]?.code).toBe('SQS_SEND_TIMEOUT');
});
test('hard send timeout aborts signal even if transport does not finish', async () => {
  const h = harness(workerConfig({ SQS_SEND_TIMEOUT_MS: '5', OUTBOX_LEASE_MS: '1010' }));
  let signal: AbortSignal | undefined;
  h.transport.publish = async (_message, receivedSignal) => { signal = receivedSignal; return new Promise<void>(() => {}); };
  expect((await h.publisher.publishNext()).action).toBe('retry-scheduled'); expect(signal?.aborted).toBe(true);
});
test('old owner cannot confirm after losing lease', async () => {
  const h = harness(); h.store.completeOutbox = async () => false;
  expect((await h.publisher.publishNext()).action).toBe('lease-lost'); expect(h.item.publishedAt).toBeUndefined();
  expect(h.diagnostics[0]?.code).toBe('FENCED');
});
test('old owner cannot reschedule after losing lease', async () => {
  const h = harness(); h.transport.publish = async () => { throw new Error('send'); }; h.store.failOutbox = async () => false;
  expect((await h.publisher.publishNext()).action).toBe('lease-lost');
});
test('SQL error after confirmed send leaves confirmation pending, never schedules a send failure', async () => {
  const h = harness(); h.store.completeOutbox = async () => { throw new Error('database unavailable'); };
  expect((await h.publisher.publishNext()).action).toBe('confirmation-pending'); expect(h.actions).not.toContain('fail');
});
test('SQL error persisting retry leaves durable claim for expiration recovery', async () => {
  const h = harness(); h.transport.publish = async () => { throw new Error('network'); };
  h.store.failOutbox = async () => { throw new Error('database'); };
  expect((await h.publisher.publishNext()).action).toBe('retry-pending');
});
test('FIFO serialization preserves exact event contract, Money strings and stable IDs', () => {
  const item = message(); const input = outboxSendInput(item, 'http://localstack/queue');
  expect(input.MessageGroupId).toBe(item.aggregateId); expect(input.MessageDeduplicationId).toBe(item.id);
  expect(JSON.parse(input.MessageBody!)).toEqual(item.payload);
  expect(JSON.parse(input.MessageBody!).data.balance.amount).toBe('100.00');
  expect(outboxSendInput(item, 'http://localstack/queue')).toEqual(input);
});
test('corrupt envelope identities are never published with a different eventId', () => {
  const item = message();
  const corrupt = OutboxMessage.rehydrate({ id: item.id, aggregateId: item.aggregateId, eventType: item.eventType,
    occurredAt: at, attempts: 0, nextAttemptAt: at, payload: { ...item.payload, eventId: randomUUID() } });
  expect(() => outboxSendInput(corrupt, 'http://localstack/queue')).toThrow('Outbox envelope identity mismatch');
});
test('unsafe configuration and invalid worker identity fail before any claim', () => {
  const h = harness();
  expect(() => new OutboxPublisher(h.uow, h.transport, { now: () => at }, { ...workerConfig({}), outboxLeaseMs: 3000 }, { workerId: 'worker' })).toThrow();
  expect(() => new OutboxPublisher(h.uow, h.transport, { now: () => at }, workerConfig({}), { workerId: '' })).toThrow();
});
