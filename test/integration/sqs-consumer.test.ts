import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, request, type Harness } from '../support/postgres';
import { createSqsHarness, until, type SqsHarness } from '../support/sqs';
import { SqsWagerConsumer, type WagerProcessor } from '../../src/modules/messaging/application/sqs-wager-consumer';
import type { SqsConsumerTransport } from '../../src/modules/messaging/application/sqs-transport';
import { SystemClock } from '../../src/shared/application/clock';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { AwsSqsConsumerTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-consumer-transport';
import { DriverException } from '@mikro-orm/core';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';

let context: { pg: Harness; sqs: SqsHarness } | undefined;
beforeEach(async () => {
  const sqs = await createSqsHarness();
  try { context = { sqs, pg: await createHarness() }; } catch (error) { await sqs.close(); throw error; }
}, 30000);
afterEach(async () => {
  const h = context; context = undefined;
  if (h) try { await h.sqs.close(); } finally { await h.pg.close(); }
}, 15000);
function ctx() { if (!context) throw new Error('Real PostgreSQL/LocalStack setup is required'); return context; }
function consumer(processor: WagerProcessor = ctx().pg.process, transport: SqsConsumerTransport = ctx().sqs.transport) {
  return new SqsWagerConsumer(processor, transport, new SystemClock(), ctx().sqs.config, () => {});
}
function envelope(input: ReturnType<typeof request>, messageId = randomUUID()) {
  const { correlationId, causationId: _cause, inbox: _inbox, ...data } = input;
  return { type: 'WagerTransactionRequested', messageId, occurredAt: new Date().toISOString(), correlationId, data };
}
async function counts(walletId: string) {
  const { pg } = ctx();
  const [row] = await pg.orm.em.fork().execute<{ debit: string; wager: string; inbox: string; outbox: string }[]>(`select
    (select count(*)::text from wallet_ledger_entries where wallet_id=? and direction='DEBIT') as debit,
    (select count(*)::text from wager_transactions where wallet_id=?) as wager,
    (select count(*)::text from inbox_messages) as inbox,
    (select count(*)::text from outbox_messages where aggregate_id=?) as outbox`, [walletId, walletId, walletId]);
  return row;
}
async function deliver(body: string, c = consumer()) {
  const { sqs } = ctx(); await sqs.send(body); const message = await sqs.receiveSource();
  return { message, outcome: await c.handle(message) };
}
async function readDeadLetter() { return until(() => ctx().sqs.readDlq()); }
async function assertConsistent(walletId: string, expectedBalance: string) {
  const { pg } = ctx();
  expect((await pg.get.execute(walletId)).balance.toString()).toBe(expectedBalance);
  expect((await pg.reconcile.execute(walletId)).consistent).toBe(true);
}
function decorated(override: Partial<SqsConsumerTransport>): SqsConsumerTransport {
  const t = ctx().sqs.transport;
  return { receive: signal => t.receive(signal), acknowledge: receipt => t.acknowledge(receipt),
    retry: (receipt, delay) => t.retry(receipt, delay), deadLetter: (body, group, dedup) => t.deadLetter(body, group, dedup), ...override };
}

test('valid real delivery commits Inbox, financial rows and Outbox before DeleteMessage', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const input = request(wallet); const e = envelope(input);
  let confirmedBeforeAck = false;
  const transport = decorated({ acknowledge: async receipt => {
    expect(await counts(wallet.id)).toEqual({ debit: '1', wager: '2', inbox: '1', outbox: '4' });
    const inbox = await h.pg.orm.em.fork().execute<{ message_id: string; processed_at: string | null }[]>('select message_id,processed_at from inbox_messages');
    expect(inbox[0]?.message_id).toBe(e.messageId); expect(inbox[0]?.processed_at).not.toBeNull();
    confirmedBeforeAck = true; await h.sqs.transport.acknowledge(receipt);
  } });
  const { outcome, message } = await deliver(JSON.stringify(e), consumer(h.pg.process, transport));
  expect(outcome.action).toBe('acked'); expect(confirmedBeforeAck).toBe(true);
  expect(message.transportMessageId).not.toBe(e.messageId);
  expect(await h.sqs.transport.receive()).toBeUndefined();
  await assertConsistent(wallet.id, '90.00');
});
test('same envelope messageId redelivery replays without a second Inbox or financial effect', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const body = JSON.stringify(envelope(request(wallet)));
  await deliver(body); const { outcome } = await deliver(body);
  expect(outcome.action).toBe('acked');
  if (outcome.action === 'acked') expect(outcome.result.idempotentReplay).toBe(true);
  expect(await counts(wallet.id)).toEqual({ debit: '1', wager: '2', inbox: '1', outbox: '4' });
  await assertConsistent(wallet.id, '90.00');
});
test('different envelope IDs with the same business key create two Inbox rows and one movement', async () => {
  const wallet = await ctx().pg.wallet(); const input = request(wallet);
  await deliver(JSON.stringify(envelope(input))); const { outcome } = await deliver(JSON.stringify(envelope(input)));
  expect(outcome.action).toBe('acked');
  if (outcome.action === 'acked') expect(outcome.result.idempotentReplay).toBe(true);
  expect(await counts(wallet.id)).toEqual({ debit: '1', wager: '2', inbox: '2', outbox: '4' });
  await assertConsistent(wallet.id, '90.00');
});
test('Inbox ID collision with a different business operation goes to DLQ without financial effect', async () => {
  const wallet = await ctx().pg.wallet(); const id = randomUUID();
  await deliver(JSON.stringify(envelope(request(wallet), id)));
  const second = request(wallet, { money: { amount: '20.00', currency: 'BRL' } });
  const { outcome } = await deliver(JSON.stringify(envelope(second, id)));
  expect(outcome).toEqual({ action: 'dead-lettered', code: 'IDEMPOTENCY_CONFLICT' });
  const dlq = await readDeadLetter(); expect(JSON.parse(dlq.Body!).errorCode).toBe('IDEMPOTENCY_CONFLICT');
  expect(dlq.Attributes?.MessageGroupId).toMatch(/^dlq-/); expect(dlq.Attributes?.MessageDeduplicationId).toMatch(/^[a-f0-9]{64}$/);
  expect(await counts(wallet.id)).toEqual({ debit: '1', wager: '2', inbox: '1', outbox: '4' });
  await assertConsistent(wallet.id, '90.00');
});
test('conflicting idempotency key with a new envelope ID is permanent and preserves history', async () => {
  const wallet = await ctx().pg.wallet(); const input = request(wallet);
  await deliver(JSON.stringify(envelope(input)));
  const { outcome } = await deliver(JSON.stringify(envelope({ ...input, money: { amount: '20.00', currency: 'BRL' } })));
  expect(outcome).toEqual({ action: 'dead-lettered', code: 'IDEMPOTENCY_CONFLICT' });
  await readDeadLetter(); await assertConsistent(wallet.id, '90.00');
  expect((await counts(wallet.id))?.inbox).toBe('1');
});
test('invalid JSON is sent to real FIFO DLQ before source removal without copying sensitive body', async () => {
  const wallet = await ctx().pg.wallet();
  expect((await deliver('{invalid secret-not-to-copy')).outcome).toEqual({ action: 'dead-lettered', code: 'INVALID_INPUT' });
  const dlq = await readDeadLetter(); expect(dlq.Body).not.toContain('secret-not-to-copy');
  expect(JSON.parse(dlq.Body!).bodyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await ctx().sqs.transport.receive()).toBeUndefined();
  expect((await counts(wallet.id))?.inbox).toBe('0'); await assertConsistent(wallet.id, '100.00');
});
test.each(['rejected', 'pending'] as const)('persisted %s is ACKed and does not enter DLQ', async mode => {
  const wallet = await ctx().pg.wallet();
  const input = mode === 'rejected' ? request(wallet, { money: { amount: '200.00', currency: 'BRL' } })
    : request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'not-yet-arrived' });
  const { outcome } = await deliver(JSON.stringify(envelope(input)));
  expect(outcome.action).toBe('acked');
  if (outcome.action === 'acked') expect(outcome.result.status).toBe(mode === 'rejected' ? WagerTransactionStatus.Rejected : WagerTransactionStatus.PendingReference);
  expect(await counts(wallet.id)).toEqual({ debit: '0', wager: '2', inbox: '1', outbox: '3' });
  expect(await ctx().sqs.readDlq()).toBeUndefined(); await assertConsistent(wallet.id, '100.00');
});
async function installTransientFailure() {
  await ctx().pg.orm.em.fork().execute(`create function cp02_transient() returns trigger as $$ begin
    if NEW.kind='BET' then raise exception 'injected transient' using errcode='40P01'; end if; return NEW; end; $$ language plpgsql;
    create trigger cp02_transient before insert on wager_transactions for each row execute function cp02_transient()`);
}
test('real PostgreSQL transient rolls back Inbox/Wallet/Outbox; SQS redelivery succeeds after recovery', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); await installTransientFailure();
  const { message, outcome } = await deliver(JSON.stringify(envelope(request(wallet))));
  expect(outcome).toEqual({ action: 'retry', code: 'POSTGRES_TRANSIENT' });
  expect(await counts(wallet.id)).toEqual({ debit: '0', wager: '1', inbox: '0', outbox: '2' });
  await assertConsistent(wallet.id, '100.00');
  await h.pg.orm.em.fork().execute('drop trigger cp02_transient on wager_transactions; drop function cp02_transient()');
  await h.sqs.transport.retry(message.receiptHandle, 0);
  const redelivery = await h.sqs.receiveSource(); expect(redelivery.receiveCount).toBeGreaterThan(1);
  expect((await consumer().handle(redelivery)).action).toBe('acked');
  await assertConsistent(wallet.id, '90.00');
});
test('real DLQ send failure leaves original message available for redelivery', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  await h.sqs.send('invalid-json'); const message = await h.sqs.receiveSource();
  await h.sqs.removeTestDlq(); // Only this test-owned queue; shared queues are untouched.
  expect(await consumer().handle(message)).toEqual({ action: 'retry', code: 'DLQ_SEND_FAILED' });
  await h.sqs.transport.retry(message.receiptHandle, 0);
  const redelivery = await h.sqs.receiveSource();
  expect(redelivery.transportMessageId).toBe(message.transportMessageId);
  expect(redelivery.receiveCount).toBeGreaterThan(1);
  await assertConsistent(wallet.id, '100.00');
});
test('injected ACK failure after real commit redelivers and replays without another debit', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  const transport = decorated({ acknowledge: async () => { throw Object.assign(new Error('injected ACK failure'), { code: 'ECONNRESET' }); } });
  const { outcome, message } = await deliver(JSON.stringify(envelope(request(wallet))), consumer(h.pg.process, transport));
  expect(outcome).toEqual({ action: 'retry', code: 'ACK_FAILED' });
  await assertConsistent(wallet.id, '90.00'); await h.sqs.transport.retry(message.receiptHandle, 0);
  const replay = await consumer().handle(await h.sqs.receiveSource()); expect(replay.action).toBe('acked');
  if (replay.action === 'acked') expect(replay.result.idempotentReplay).toBe(true);
  expect(await counts(wallet.id)).toEqual({ debit: '1', wager: '2', inbox: '1', outbox: '4' });
  await assertConsistent(wallet.id, '90.00');
});
test.each(['unknown', 'postgres-no-code', 'uncertain-commit'] as const)('REV3-01 %s preserves original through native redrive and recovers exactly one financial effect', async mode => {
  const h = ctx(); const wallet = await h.pg.wallet(); const original = envelope(request(wallet));
  const body = JSON.stringify(original); await h.sqs.send(body);
  const cause = new Error('Connection terminated unexpectedly');
  const error = new DriverException(cause); // Installed MikroORM conversion preserves the absence of code.
  expect(error.code).toBeUndefined(); expect(cause.message).toBe('Connection terminated unexpectedly');
  const failing = new ProcessWagerTransactionUseCase(h.pg.uow, { checkpoint: async phase => {
    if (phase === 'beforeCommit') throw error; // Real SQL rollback, without disrupting any other connection.
  } });
  let manualSends = 0; let deletes = 0;
  const transport = decorated({
    acknowledge: async receipt => { deletes++; await h.sqs.transport.acknowledge(receipt); },
    deadLetter: async (b, group, dedup) => { manualSends++; await h.sqs.transport.deadLetter(b, group, dedup); },
  });
  const c = consumer({ execute: async input => {
    if (mode === 'postgres-no-code') return failing.execute(input);
    if (mode === 'uncertain-commit') await h.pg.process.execute(input); // Commit real; its confirmation is lost at the boundary.
    throw mode === 'uncertain-commit' ? error : new TypeError('injected unknown error');
  } }, transport);
  for (let attempt = 1; attempt <= h.sqs.config.maxReceiveCount; attempt++) {
    const message = await h.sqs.receiveSource(); expect(message.receiveCount).toBe(attempt);
    expect(await c.handle(message)).toEqual({ action: 'retry', code: 'UNKNOWN_ERROR' });
    await h.sqs.transport.retry(message.receiptHandle, 0);
  }
  expect(manualSends).toBe(0); expect(deletes).toBe(0);
  const dead = await until(async () => {
    const message = await h.sqs.transport.receive();
    if (message) await h.sqs.transport.retry(message.receiptHandle, 0);
    return h.sqs.readDlq();
  });
  // Native queue RedrivePolicy, never an application forwarding mechanism, moved this body.
  expect(dead.Body === body).toBe(true);
  const recovered = JSON.parse(dead.Body!) as typeof original;
  expect(recovered.messageId).toBe(original.messageId);
  expect(recovered.data.idempotencyKey).toBe(original.data.idempotencyKey);
  expect(recovered.data.externalTransactionId).toBe(original.data.externalTransactionId);
  expect(await counts(wallet.id)).toEqual(mode === 'uncertain-commit'
    ? { debit: '1', wager: '2', inbox: '1', outbox: '4' }
    : { debit: '0', wager: '1', inbox: '0', outbox: '2' });
  await assertConsistent(wallet.id, mode === 'uncertain-commit' ? '90.00' : '100.00');
  // Operational replay after the fault is removed, preserving the business/envelope identities.
  await h.sqs.send(dead.Body!, 'recovery', randomUUID());
  await h.sqs.client.send(new DeleteMessageCommand({ QueueUrl: h.sqs.dlqUrl, ReceiptHandle: dead.ReceiptHandle! }),
    { abortSignal: AbortSignal.timeout(5000) });
  const outcome = await consumer().handle(await h.sqs.receiveSource());
  expect(outcome.action).toBe('acked');
  if (outcome.action === 'acked') expect(outcome.result.idempotentReplay).toBe(mode === 'uncertain-commit');
  // A further duplicate proves recovery did not merely rely on FIFO deduplication.
  const duplicate = await deliver(body);
  expect(duplicate.outcome.action).toBe('acked');
  if (duplicate.outcome.action === 'acked') expect(duplicate.outcome.result.idempotentReplay).toBe(true);
  expect(await counts(wallet.id)).toEqual({ debit: '1', wager: '2', inbox: '1', outbox: '4' });
  const inbox = await h.pg.orm.em.fork().execute<{ message_id: string; processed_at: string | null }[]>('select message_id,processed_at from inbox_messages');
  expect(inbox[0]?.message_id).toBe(original.messageId); expect(inbox[0]?.processed_at).not.toBeNull();
  await assertConsistent(wallet.id, '90.00');
}, 20000);
test('persistent PostgreSQL transient exhausts native SQS redrive without any financial commit', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const body = JSON.stringify(envelope(request(wallet))); await installTransientFailure();
  await h.sqs.send(body);
  for (let i = 0; i < h.sqs.config.maxReceiveCount; i++) {
    const message = await h.sqs.receiveSource();
    expect((await consumer().handle(message)).action).toBe('retry');
    await h.sqs.transport.retry(message.receiptHandle, 0);
  }
  const dead = await until(async () => {
    const message = await h.sqs.transport.receive();
    // Native redrive may take a receive cycle to move the exhausted source.
    if (message) await h.sqs.transport.retry(message.receiptHandle, 0);
    return h.sqs.readDlq();
  });
  expect(dead.Body).toBe(body); // Native redrive preserves the original body.
  expect(await counts(wallet.id)).toEqual({ debit: '0', wager: '1', inbox: '0', outbox: '2' });
  await assertConsistent(wallet.id, '100.00');
}, 15000);
test('consumer startup refuses maxReceiveCount mismatch against actual redrive policy', async () => {
  const h = ctx();
  await expect(AwsSqsConsumerTransport.connect(h.sqs.client, { ...h.sqs.config, maxReceiveCount: 4 }, h.sqs.inputName, h.sqs.dlqName)).rejects.toThrow('SQS redrive policy/config mismatch');
});
