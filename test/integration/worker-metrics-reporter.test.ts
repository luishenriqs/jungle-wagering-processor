import 'reflect-metadata';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { DefaultOperationalMetricsCollector, type OperationalMetricsSnapshot } from '../../src/shared/application/operational-metrics';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction';
import { createHarness, request, testDatabaseUrl, type Harness } from '../support/postgres';
import { createSqsHarness, type SqsHarness } from '../support/sqs';
import { createOutboxSqsHarness, type OutboxSqsHarness } from '../support/outbox-sqs';
import { entrypointClient, entrypoints, type EntrypointClient, type Entrypoint } from '../support/entrypoint-client';

interface Frame { type: 'OperationalMetricsSnapshot'; version: number; component: string; executionId: string; pid: number; timestamp: string; snapshot: OperationalMetricsSnapshot }
let context: { pg: Harness; sqs: SqsHarness; events: OutboxSqsHarness; children: EntrypointClient[] } | undefined;
beforeEach(async () => {
  const url = new URL(testDatabaseUrl()); expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe('5434');
  const pg = await createHarness(); let sqs: SqsHarness | undefined;
  try { sqs = await createSqsHarness(); context = { pg, sqs, events: await createOutboxSqsHarness(), children: [] }; }
  catch (error) { await sqs?.close(); await pg.close(); throw error; }
}, 30000);
afterEach(async () => {
  const h = context; context = undefined;
  if (h) try { for (const child of h.children) await child.close(); }
  finally { try { await h.events.close(); } finally { try { await h.sqs.close(); } finally { await h.pg.close(); } } }
}, 15000);
function ctx() { if (!context) throw new Error('Isolated resources required'); return context; }
function env() {
  const h = ctx(); return { ...process.env, DATABASE_URL: h.pg.url, TEST_DATABASE_URL: h.pg.url, JUNGLE_ENTRYPOINT_SMOKE: 'yes', JUNGLE_TEST_SCHEMA: h.pg.schema,
    SQS_ENDPOINT: 'http://127.0.0.1:4566', SQS_INPUT_QUEUE_NAME: h.sqs.inputName, SQS_DLQ_QUEUE_NAME: h.sqs.dlqName, SQS_EVENTS_QUEUE_NAME: h.events.name,
    SQS_MAX_RECEIVE_COUNT: '3', SQS_WAIT_SECONDS: '1', SQS_VISIBILITY_TIMEOUT_SECONDS: '30', SQS_RETRY_BASE_SECONDS: '1', SQS_RETRY_MAX_SECONDS: '1',
    WORKER_SHUTDOWN_TIMEOUT_MS: '5000', WORKER_METRICS_INTERVAL_MS: '50', OUTBOX_POLL_INTERVAL_MS: '50', OUTBOX_LEASE_MS: '2000', SQS_SEND_TIMEOUT_MS: '500',
    OUTBOX_BASE_RETRY_MS: '500', OUTBOX_MAX_RETRY_MS: '500', PENDING_REF_BASE_DELAY_MS: '50', PENDING_REF_TTL_MS: '60000',
    PENDING_REF_MAX_ATTEMPTS: '10', PENDING_REF_POLL_INTERVAL_MS: '50', PENDING_REF_BATCH_SIZE: '100' };
}
function frames(child: EntrypointClient): Frame[] {
  return (child.records as unknown as Frame[]).filter(r => r.type === 'OperationalMetricsSnapshot');
}
async function exported(child: EntrypointClient, predicate: (s: OperationalMetricsSnapshot) => boolean, timeout = 10000) {
  await child.waitFor(r => (r as unknown as Frame).type === 'OperationalMetricsSnapshot' && predicate((r as unknown as Frame).snapshot), timeout);
  return frames(child).find(f => predicate(f.snapshot))!;
}
async function start(script: Entrypoint) {
  const child = entrypointClient(script, env()); ctx().children.push(child);
  await child.waitFor(r => r.action === 'started'); return child;
}
async function stop(child: EntrypointClient) {
  child.signal(); expect(await child.done).toEqual({ code: 0, signal: null }); expect(child.invalidOutput).toBe(false);
  expect(child.records.some(r => r.phase === 'stopped')).toBe(true);
}
function envelope(data: ReturnType<typeof request>) { return JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), occurredAt: new Date().toISOString(), data }); }

test.each(entrypoints)('D04-FIX-T01/T05/T06 real %s exports NDJSON with fresh execution identity on restart', async (script, component) => {
  const first = await start(script);
  const frame = await exported(first, () => true, 2500);
  expect(frame.version).toBe(1); expect(frame.component).toBe(component); expect(frame.executionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(frame.pid).toBeInteger(); expect(frame.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(frame.snapshot).toEqual(new DefaultOperationalMetricsCollector().snapshot());
  const h = ctx(); const wallet = await h.pg.wallet(); const input = request(wallet);
  if (component === 'sqs-consumer') {
    await h.sqs.send(envelope(input), wallet.id);
    await exported(first, s => s.transactionsByStatus.PROCESSED === 1);
  } else if (component === 'outbox-publisher') await exported(first, s => s.outboxLagMs.count === 2);
  else {
    await h.pg.process.execute(request(wallet, { kind: Kind.Refund, referenceExternalTransactionId: input.externalTransactionId }));
    await h.pg.process.execute(input); await exported(first, s => s.pendingReference.processed === 1);
  }
  await stop(first);
  const beforeRestart = await h.pg.reconcile.execute(wallet.id); expect(beforeRestart.consistent).toBe(true);
  const second = await start(script); const reset = await exported(second, () => true);
  expect(reset.executionId).not.toBe(frame.executionId); expect(reset.pid).not.toBe(frame.pid);
  expect(reset.snapshot).toEqual(frame.snapshot); await stop(second);
  expect(await h.pg.reconcile.execute(wallet.id)).toEqual(beforeRestart);
}, 15000);

test('D04-FIX-T02/T13/T14 consumer exports confirmed retry, DLQ and commit; HTTP collector stays independent', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const input = request(wallet);
  const http = await NestFactory.create(AppModule.register({ uow: h.pg.uow }), { logger: false, abortOnError: false });
  await http.listen(0, '127.0.0.1');
  try {
    const httpUrl = await http.getUrl(); const httpBefore = await (await fetch(`${httpUrl}/metrics`)).json();
    await h.pg.orm.em.fork().execute(`create function d04_transient() returns trigger language plpgsql as $$ begin raise exception 'D04 test rollback' using errcode='40001'; end $$`);
    await h.pg.orm.em.fork().execute('create trigger d04_transient before update on wallets for each row execute function d04_transient()');
    const child = await start('scripts/consume-wagers.ts'); await h.sqs.send(envelope(input), wallet.id);
    const retried = await exported(child, s => s.retries.sqsConsumer > 0);
    expect(retried.snapshot.concurrencyConflicts.byCode['40001']).toBe(3);
    expect(retried.snapshot.transactionsByStatus.PROCESSED).toBe(0);
    expect((await h.pg.get.execute(wallet.id)).balance.toString()).toBe('100.00');
    expect(await h.pg.orm.em.fork().execute('select count(*)::text as n from inbox_messages')).toEqual([{ n: '0' }]);
    expect(await h.pg.orm.em.fork().execute('select count(*)::text as n from outbox_messages')).toEqual([{ n: '2' }]);
    await h.pg.orm.em.fork().execute('drop trigger d04_transient on wallets'); await h.pg.orm.em.fork().execute('drop function d04_transient()');
    await exported(child, s => s.transactionsByStatus.PROCESSED === 1);
    await h.sqs.send('D04_SYNTHETIC_SECRET_invalid_body', `bad-${randomUUID()}`);
    const dead = await exported(child, s => s.dlq.confirmedTransfers === 1);
    expect(dead.snapshot.retries.sqsConsumer).toBe(1); expect(await h.sqs.readDlq()).toBeDefined();
    expect(await (await fetch(`${httpUrl}/metrics`)).json()).toEqual(httpBefore);
    await stop(child);
    expect(JSON.stringify(frames(child))).not.toMatch(/SYNTHETIC_SECRET|playerId|walletId|receiptHandle|postgres(?:ql)?:\/\//);
    const reconciliation = await h.pg.reconcile.execute(wallet.id); expect(reconciliation.consistent).toBe(true); expect(reconciliation.storedBalance.amount).toBe('90.00');
  } finally { await http.close(); }
}, 20000);

test('D04-FIX-T03/T14 publisher lag follows SQL confirmation and exports recovery after real queue failure', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  await h.pg.orm.em.fork().execute(`create function d04_confirm_failure() returns trigger language plpgsql as $$ begin if NEW.published_at is not null then raise exception 'D04 commit failure' using errcode='40001'; end if; return NEW; end $$`);
  await h.pg.orm.em.fork().execute('create trigger d04_confirm_failure before update on outbox_messages for each row execute function d04_confirm_failure()');
  const child = await start('scripts/publish-outbox.ts');
  await child.waitFor(r => r.code === 'CONFIRMATION_PERSIST_FAILED');
  expect(frames(child).every(f => f.snapshot.outboxLagMs.count === 0)).toBe(true);
  expect(await h.pg.orm.em.fork().execute('select count(*)::text as n from outbox_messages where published_at is not null')).toEqual([{ n: '0' }]);
  await h.pg.orm.em.fork().execute('drop trigger d04_confirm_failure on outbox_messages'); await h.pg.orm.em.fork().execute('drop function d04_confirm_failure()');
  const confirmed = await exported(child, s => s.outboxLagMs.count === 2);
  expect(confirmed.snapshot.outboxLagMs.totalMs).toBeGreaterThanOrEqual(0);
  const queueUrl = (await h.events.client.send(new GetQueueUrlCommand({ QueueName: h.events.name }))).QueueUrl!;
  await h.events.client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  await h.pg.process.execute(request(wallet, { kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } }));
  const retry = await exported(child, s => s.retries.outboxPublisher > 0);
  expect(retry.snapshot.outboxLagMs.count).toBe(2);
  await h.events.client.send(new CreateQueueCommand({ QueueName: h.events.name, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '5' } }));
  await exported(child, s => s.outboxLagMs.count === 3); expect((await h.events.read()).length).toBeGreaterThan(0);
  await stop(child); expect((await h.pg.reconcile.execute(wallet.id)).consistent).toBe(true);
}, 20000);

test('D04-FIX-T04 pending entrypoint exports reschedule and resolution with no duplicate credit', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const bet = request(wallet);
  const processor = new ProcessWagerTransactionUseCase(h.pg.uow, { pendingReferencePolicy: { baseDelayMs: 50, maxAttempts: 10, ttlMs: 60000 } });
  const pending = request(wallet, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
  expect(String((await processor.execute(pending)).status)).toBe('PENDING_REFERENCE');
  const child = await start('scripts/resolve-pending-references.ts'); await exported(child, s => s.pendingReference.rescheduled > 0);
  await processor.execute(bet); const resolved = await exported(child, s => s.pendingReference.processed === 1);
  expect(resolved.snapshot.pendingReference.rescheduled).toBeGreaterThan(0); await stop(child);
  expect((await processor.execute(pending)).idempotentReplay).toBe(true);
  const check = await h.pg.reconcile.execute(wallet.id); expect(check.consistent).toBe(true); expect(check.storedBalance.amount).toBe('100.00'); expect(check.checkedEntries).toBe(3);
}, 15000);

for (const [script, component] of entrypoints) for (const mode of ['throw', 'reject', 'never'] as const) {
  test(`D04-FIX-T07/T08/T09/T10/T12 ${component} writer=${mode} preserves real work and SIGTERM`, async () => {
    const h = ctx(); const wallet = await h.pg.wallet(); const input = request(wallet);
    if (component === 'sqs-consumer') await h.sqs.send(envelope(input), wallet.id);
    if (component === 'pending-reference-worker') {
      await h.pg.process.execute(request(wallet, { kind: Kind.Refund, referenceExternalTransactionId: input.externalTransactionId }));
      await h.pg.process.execute(input);
    }
    const child = entrypointClient(script, { ...env(), JUNGLE_TEST_METRICS_WRITER_FAULT: mode }, ['./test/support/worker-metrics-fault-preload.ts']);
    h.children.push(child); await child.waitFor(r => r.action === 'started');
    await child.waitFor(r => r.phase === 'metrics-writer-attempt');
    if (component === 'sqs-consumer') await child.waitFor(r => r.phase === 'delete-confirmed');
    else if (component === 'outbox-publisher') await child.waitFor(r => r.code === 'PUBLISHED');
    else await child.waitFor(r => (r as unknown as { event?: string }).event === 'pending_reference_resolved');
    await stop(child);
    expect(frames(child)).toEqual([]);
    if (mode === 'never') expect(child.records.filter(r => r.phase === 'metrics-writer-attempt')).toHaveLength(1);
    const check = await h.pg.reconcile.execute(wallet.id); expect(check.consistent).toBe(true);
    expect(check.storedBalance.amount).toBe(component === 'sqs-consumer' ? '90.00' : '100.00');
    expect(check.checkedEntries).toBe(component === 'sqs-consumer' ? 2 : component === 'pending-reference-worker' ? 3 : 1);
  }, 15000);
}
