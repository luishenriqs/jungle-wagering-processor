import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, request, type Harness } from '../support/postgres';
import { createSqsHarness, until, type SqsHarness } from '../support/sqs';
import { createOutboxSqsHarness, type OutboxSqsHarness } from '../support/outbox-sqs';
import { entrypointClient, entrypoints, type EntrypointClient } from '../support/entrypoint-client';
import { entrypointIsolation } from '../support/entrypoint-isolation';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';

let context: { pg: Harness; sqs: SqsHarness; events: OutboxSqsHarness; children: EntrypointClient[] } | undefined;
beforeEach(async () => {
  const pg = await createHarness(); let sqs: SqsHarness | undefined;
  try { sqs = await createSqsHarness(); context = { pg, sqs, events: await createOutboxSqsHarness(), children: [] }; }
  catch (error) { try { await sqs?.close(); } finally { await pg.close(); } throw error; }
}, 30000);
afterEach(async () => {
  const h = context; context = undefined;
  if (h) {
    try { await Promise.all(h.children.map(c => c.close())); }
    finally { try { await h.events.close(); } finally { try { await h.sqs.close(); } finally { await h.pg.close(); } } }
  }
}, 15000);
function ctx() { if (!context) throw new Error('Isolated real entrypoint resources required'); return context; }
function environment() {
  const h = ctx();
  return { ...process.env, NODE_ENV: 'test', JUNGLE_ENTRYPOINT_SMOKE: 'yes', JUNGLE_TEST_SCHEMA: h.pg.schema,
    DATABASE_URL: h.pg.url, TEST_DATABASE_URL: h.pg.url,
    SQS_ENDPOINT: process.env['SQS_ENDPOINT'] ?? 'http://127.0.0.1:4566', AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
    SQS_INPUT_QUEUE_NAME: h.sqs.inputName, SQS_DLQ_QUEUE_NAME: h.sqs.dlqName, SQS_EVENTS_QUEUE_NAME: h.events.name,
    SQS_CONSUMER_NAME: h.sqs.config.consumerName, SQS_MAX_RECEIVE_COUNT: String(h.sqs.config.maxReceiveCount),
    SQS_WAIT_SECONDS: '20', SQS_VISIBILITY_TIMEOUT_SECONDS: '30', SQS_REQUEST_TIMEOUT_MS: '3000',
    SQS_RETRY_BASE_SECONDS: '1', SQS_RETRY_MAX_SECONDS: '60', WORKER_SHUTDOWN_TIMEOUT_MS: '5000',
    OUTBOX_WORKER_ID: `smoke-${randomUUID()}`, OUTBOX_POLL_INTERVAL_MS: '20', OUTBOX_LEASE_MS: '10000',
    SQS_SEND_TIMEOUT_MS: '3000', OUTBOX_BASE_RETRY_MS: '1000', OUTBOX_MAX_RETRY_MS: '60000',
    PENDING_REF_BASE_DELAY_MS: '1000', PENDING_REF_MAX_ATTEMPTS: '10', PENDING_REF_TTL_MS: '86400000',
    PENDING_REF_POLL_INTERVAL_MS: '20', PENDING_REF_BATCH_SIZE: '100' };
}
async function stop(child: EntrypointClient, usesSqs: boolean) {
  child.signal(); await child.waitFor(r => r.phase === 'stopped', 10000);
  expect(await child.done).toEqual({ code: 0, signal: null });
  const phases = child.records.map(r => r.phase);
  for (const phase of ['resources-verified', 'drain-started', 'drained', 'pool-close-started', 'pool-closed', 'stopped']) expect(phases).toContain(phase);
  expect(phases.indexOf('drained')).toBeLessThan(phases.indexOf('pool-close-started'));
  expect(phases.indexOf('pool-close-started')).toBeLessThan(phases.indexOf('pool-closed'));
  expect(phases.indexOf('pool-closed')).toBeLessThan(phases.indexOf('stopped'));
  expect(phases.includes('sqs-closed')).toBe(usesSqs);
  if (usesSqs) expect(phases.indexOf('sqs-closed')).toBeLessThan(phases.indexOf('stopped'));
  expect(phases.some(p => ['timeout', 'drain-failed', 'loop-failed'].includes(p ?? ''))).toBe(false);
  expect(child.invalidOutput).toBe(false);
  const [sessions] = await ctx().pg.orm.em.fork().execute<{ n: string }[]>(
    'select count(*)::text as n from pg_stat_activity where application_name=?', [`jungle-smoke-${ctx().pg.schema}`]);
  expect(sessions?.n).toBe('0');
}
async function snapshot(walletId: string) {
  const h = ctx();
  const [row] = await h.pg.orm.em.fork().execute<{ ledger: string; wager: string; inbox: string; outbox: string }[]>(`select
    (select count(*)::text from wallet_ledger_entries where wallet_id=?) as ledger,
    (select count(*)::text from wager_transactions where wallet_id=?) as wager,
    (select count(*)::text from inbox_messages) as inbox,
    (select count(*)::text from outbox_messages where aggregate_id=?) as outbox`, [walletId, walletId, walletId]);
  return { ...row, balance: (await h.pg.get.execute(walletId)).balance.toString() };
}

test.each(entrypoints)('REV3-02 real %s starts, performs work, SIGTERM closes resources and restart is idempotent', async (script, component) => {
  const h = ctx(); const wallet = await h.pg.wallet(); const input = request(wallet);
  let expectedBalance = '100.00';
  if (component === 'sqs-consumer') {
    const body = JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), occurredAt: new Date().toISOString(), data: input });
    await h.sqs.send(body); await h.sqs.send(body); expectedBalance = '90.00';
  } else if (component === 'pending-reference-worker') {
    const pending = request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: input.externalTransactionId });
    await new ProcessWagerTransactionUseCase(h.pg.uow, { pendingReferencePolicy: { baseDelayMs: 1, maxAttempts: 10, ttlMs: 86400000 } }).execute(pending);
    await h.pg.process.execute(input); // The real entrypoint must resolve the persisted REFUND.
  }
  const env = environment(); entrypointIsolation(env);
  // Verify actual parent-owned schema before launching a production script. Child verifies its own connection too.
  const [owned] = await h.pg.orm.em.fork().execute<{ n: string }[]>('select count(*)::text as n from pg_namespace where nspname=?', [h.pg.schema]);
  expect(owned?.n).toBe('1');
  const start = async () => {
    const child = entrypointClient(script, env); h.children.push(child);
    await child.waitFor(r => r.component === component && r.action === 'started');
    expect(child.records.findIndex(r => r.phase === 'resources-verified')).toBeLessThan(
      child.records.findIndex(r => r.action === 'started'));
    return child;
  };
  const child = await start();
  if (component === 'outbox-publisher') {
    const expected = await h.pg.orm.em.fork().execute<{ id: string }[]>('select id from outbox_messages');
    const seen = new Set<string>();
    await until(async () => {
      for (const e of await h.events.read()) seen.add(String(e.payload['eventId']));
      const [pending] = await h.pg.orm.em.fork().execute<{ n: string }[]>('select count(*)::text as n from outbox_messages where published_at is null');
      return pending?.n === '0' && seen.size === expected.length ? true : undefined;
    }, 10000);
    expect([...seen].sort()).toEqual(expected.map(r => r.id).sort());
  } else {
    await until(async () => {
      const state = await snapshot(wallet.id);
      return component === 'sqs-consumer' ? (state.balance === '90.00' && state.inbox === '1' ? true : undefined)
        : (state.balance === '100.00' && state.ledger === '3' ? true : undefined);
    }, 10000);
    if (component === 'sqs-consumer') {
      // Both separately enqueued duplicates must actually pass through the production consumer.
      await child.waitFor(() => child.records.filter(r => r.phase === 'delete-confirmed').length >= 2);
    }
  }
  await stop(child, component !== 'pending-reference-worker');
  const first = await snapshot(wallet.id);
  expect(first).toEqual(component === 'sqs-consumer'
    ? { ledger: '2', wager: '2', inbox: '1', outbox: '4', balance: '90.00' }
    : component === 'pending-reference-worker'
      ? { ledger: '3', wager: '3', inbox: '0', outbox: '7', balance: '100.00' }
      : { ledger: '1', wager: '1', inbox: '0', outbox: '2', balance: '100.00' });
  // Same production script with no remaining work: startup/shutdown must not create financial artifacts.
  await stop(await start(), component !== 'pending-reference-worker');
  expect(await snapshot(wallet.id)).toEqual(first);
  const reconciliation = await h.pg.reconcile.execute(wallet.id);
  expect(reconciliation.consistent).toBe(true); expect(reconciliation.storedBalance.amount).toBe(expectedBalance);
}, 40000);

test.each(entrypoints)('REV3-02 real %s rejects invalid startup with sanitized nonzero exit', async (script, component) => {
  const env = { ...environment(), ...(component === 'sqs-consumer' ? { SQS_WAIT_SECONDS: '21' }
    : component === 'outbox-publisher' ? { OUTBOX_POLL_INTERVAL_MS: '0' } : { PENDING_REF_BATCH_SIZE: '0' }) };
  const child = entrypointClient(script, env); ctx().children.push(child);
  await child.waitFor(r => r.component === component && r.action === 'startup-failed');
  const result = await child.done; expect(result.code).toBe(1); expect(result.signal).toBeNull();
  const diagnostic = child.records.find(r => r.action === 'startup-failed');
  expect(diagnostic).toEqual({ component, action: 'startup-failed', code: component === 'pending-reference-worker'
    ? 'CHECK_DATABASE_AND_PENDING_CONFIGURATION' : 'CHECK_DATABASE_AND_SQS_CONFIGURATION' });
  expect(child.records.some(r => r.action === 'started')).toBe(false); expect(child.invalidOutput).toBe(false);
  const output = JSON.stringify(child.records);
  expect(output.includes(env.DATABASE_URL)).toBe(false);
  expect(output).not.toMatch(/ReceiptHandle|password|stack|postgres(?:ql)?:\/\//i);
  const [sessions] = await ctx().pg.orm.em.fork().execute<{ n: string }[]>(
    'select count(*)::text as n from pg_stat_activity where application_name=?', [`jungle-smoke-${ctx().pg.schema}`]);
  expect(sessions?.n).toBe('0');
}, 25000);
