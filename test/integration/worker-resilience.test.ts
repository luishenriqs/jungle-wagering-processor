import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, request, type Harness } from '../support/postgres';
import { createSqsHarness, type SqsHarness } from '../support/sqs';
import { createOutboxSqsHarness, type OutboxSqsHarness } from '../support/outbox-sqs';
import { resilienceClient, type ResilienceClient, type ResilienceMode } from '../support/resilience-client';
import { SqsWagerConsumer } from '../../src/modules/messaging/application/sqs-wager-consumer';
import { SystemClock } from '../../src/shared/application/clock';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { pendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';

const epoch = new Date('2035-01-01T00:00:00Z');
let context: { pg: Harness; sqs: SqsHarness; events: OutboxSqsHarness; children: ResilienceClient[] } | undefined;
beforeEach(async () => {
  const pg = await createHarness(); let sqs: SqsHarness | undefined;
  try { sqs = await createSqsHarness(); context = { pg, sqs, events: await createOutboxSqsHarness(), children: [] }; }
  catch (error) { try { if (sqs) await sqs.close(); } finally { await pg.close(); } throw error; }
}, 30000);
afterEach(async () => {
  const h = context; context = undefined;
  if (h) {
    await Promise.all(h.children.map(c => c.close()));
    try { await h.events.close(); } finally { try { await h.sqs.close(); } finally { await h.pg.close(); } }
  }
}, 15000);
function ctx() { if (!context) throw new Error('Real PostgreSQL and LocalStack are required'); return context; }
async function child(mode: ResilienceMode, now = epoch, timeout = 5000) {
  const h = ctx(); const c = await resilienceClient(h.pg, h.sqs, h.events, mode, now, timeout); h.children.push(c); return c;
}
function body(input: ReturnType<typeof request>) {
  const { correlationId, causationId: _cause, inbox: _inbox, ...data } = input;
  return JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), occurredAt: epoch.toISOString(), correlationId, data });
}
async function snapshot(walletId: string) {
  const h = ctx(); const wallet = await h.pg.get.execute(walletId);
  const [counts] = await h.pg.orm.em.fork().execute<{ debit: string; ledger: string; inbox: string; outbox: string }[]>(`select
    (select count(*)::text from wallet_ledger_entries where wallet_id=? and direction='DEBIT') as debit,
    (select count(*)::text from wallet_ledger_entries where wallet_id=?) as ledger,
    (select count(*)::text from inbox_messages) as inbox,
    (select count(*)::text from outbox_messages where aggregate_id=?) as outbox`, [walletId,walletId,walletId]);
  return { ...counts, balance: wallet.balance.toString(), version: wallet.version };
}
async function reconcile(id: string, amount: string) {
  const r = await ctx().pg.reconcile.execute(id); expect(r.consistent).toBe(true); expect(r.storedBalance.amount).toBe(amount);
}
function assertGraceful(c: ResilienceClient) {
  expect(c.records.some(r => r.phase === 'stopped')).toBe(true);
  expect(c.records.some(r => r.phase === 'timeout')).toBe(false);
  expect(c.records.find(r => r.phase === 'pool-closed')?.connected).toBe(false);
}
async function stop(c: ResilienceClient) {
  c.signal('SIGTERM'); await c.phase('drained'); await c.phase('pool-closed'); await c.phase('stopped');
  const exit = await c.done; assertGraceful(c); expect(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM').toBe(true);
  const closing = c.records.find(r => r.phase === 'pool-close-started')!;
  expect(closing.activeProcessor).toBe(false); expect(closing.ackInFlight).toBe(false);
  expect(c.records.find(r => r.phase === 'pool-closed')?.connected).toBe(false);
  expect(c.records.findIndex(r => r.phase === 'drained')).toBeLessThan(c.records.findIndex(r => r.phase === 'pool-close-started'));
}
async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() >= deadline) throw new Error('Real worker condition timeout'); await new Promise(r => setTimeout(r, 20)); }
}
async function published() {
  const [r] = await ctx().pg.orm.em.fork().execute<{ n: string }[]>('select count(*)::text as n from outbox_messages where published_at is null'); return r?.n === '0';
}
async function eventIds(count: number) {
  const seen = new Set<unknown>(); await waitUntil(async () => { for (const e of await ctx().events.read()) seen.add(e.payload['eventId']); return seen.size >= count; }); return seen;
}

test.each(['consumer-before-commit','consumer-after-commit'] as const)('SIGTERM %s drains commit/ACK before closing actual MikroORM pool', async mode => {
  const h = ctx(); const wallet = await h.pg.wallet(); await h.sqs.send(body(request(wallet)));
  const c = await child(mode); c.start(); await c.phase(mode === 'consumer-before-commit' ? 'before-commit' : 'after-commit-before-ack');
  expect(c.records.some(r => r.phase === 'acked')).toBe(false);
  c.signal('SIGTERM'); await c.phase('drain-started');
  expect(c.records.some(r => r.phase === 'pool-close-started')).toBe(false);
  c.release(); const ack = await c.phase('acked'); expect(ack.poolOpen).toBe(true);
  await c.phase('pool-closed'); const exit = await c.done; assertGraceful(c); expect(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM').toBe(true);
  expect(c.records.find(r => r.phase === 'pool-close-started')?.activeProcessor).toBe(false);
  expect(c.records.findIndex(r => r.phase === 'acked')).toBeLessThan(c.records.findIndex(r => r.phase === 'pool-close-started'));
  expect(c.records.find(r => r.phase === 'pool-closed')?.connected).toBe(false);
  expect(await snapshot(wallet.id)).toEqual({ debit: '1', ledger: '2', inbox: '1', outbox: '4', balance: '90.00', version: 2 });
  expect(await h.sqs.transport.receive()).toBeUndefined(); await reconcile(wallet.id, '90.00');
}, 20000);
test('SIGTERM cancels real idle long polling, then a restarted consumer processes new work', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const c = await child('consumer-idle'); c.start(); await c.phase('poll-started');
  const started = Date.now(); await stop(c); expect(Date.now() - started).toBeLessThan(5000); // WaitTimeSeconds is 20.
  await c.phase('poll-abort-observed'); await c.phase('poll-cancelled');
  const phases = c.records.map(r => r.phase);
  expect(phases.indexOf('poll-abort-observed')).toBeLessThan(phases.indexOf('poll-cancelled'));
  expect(phases.indexOf('poll-cancelled')).toBeLessThan(phases.indexOf('drained'));
  expect(c.records.filter(r => r.phase === 'poll-started')).toHaveLength(1);
  expect(c.records.some(r => r.phase === 'poll-returned' || r.phase === 'committed' || r.phase === 'acked')).toBe(false);
  await h.sqs.send(body(request(wallet))); const restarted = await child('consumer-normal'); restarted.start(); await restarted.phase('acked'); await stop(restarted);
  expect(restarted.pid).not.toBe(c.pid); expect((await snapshot(wallet.id)).debit).toBe('1'); await reconcile(wallet.id, '90.00');
}, 25000);
test('SIGTERM after receipt but before processing releases real visibility without ACK or financial effects', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); await h.sqs.send(body(request(wallet)));
  const c = await child('consumer-received'); c.start(); await c.phase('received-unprocessed');
  c.signal('SIGTERM'); await c.phase('drain-started'); c.release(); await c.phase('visibility-released'); await c.phase('pool-closed'); await c.done; assertGraceful(c);
  expect(c.records.some(r => r.phase === 'committed' || r.phase === 'acked')).toBe(false);
  expect(await snapshot(wallet.id)).toEqual({ debit: '0', ledger: '1', inbox: '0', outbox: '2', balance: '100.00', version: 1 });
  const message = await h.sqs.receiveSource(); expect(message.receiveCount).toBeGreaterThan(1);
  const consumer = new SqsWagerConsumer(h.pg.process, h.sqs.transport, new SystemClock(), h.sqs.config, () => {});
  expect((await consumer.handle(message)).action).toBe('acked'); await reconcile(wallet.id, '90.00');
}, 20000);
test.each(['consumer-crash-before-commit','consumer-after-commit'] as const)('SIGKILL %s recovers after restart through persistent rollback/replay, never graceful hooks', async mode => {
  const h = ctx(); const wallet = await h.pg.wallet(); await h.sqs.send(body(request(wallet)));
  const c = await child(mode); c.start(); await c.phase(mode === 'consumer-after-commit' ? 'after-commit-before-ack' : 'before-commit');
  c.signal('SIGKILL'); expect((await c.done).signal).toBe('SIGKILL');
  expect(c.records.some(r => r.phase === 'drained' || r.phase === 'acked' || r.phase === 'pool-closed')).toBe(false);
  expect((await snapshot(wallet.id)).balance).toBe(mode === 'consumer-after-commit' ? '90.00' : '100.00');
  const restarted = await child('consumer-normal'); restarted.start(); await restarted.phase('acked'); await stop(restarted);
  expect(restarted.records.find(r => r.phase === 'committed')?.replay).toBe(mode === 'consumer-after-commit');
  expect(await snapshot(wallet.id)).toEqual({ debit: '1', ledger: '2', inbox: '1', outbox: '4', balance: '90.00', version: 2 });
  await reconcile(wallet.id, '90.00');
}, 25000);
test('configured shutdown deadline forces non-graceful exit without ACK and recovery rolls back uncommitted money', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); await h.sqs.send(body(request(wallet)));
  const c = await child('consumer-timeout', epoch, 200); c.start(); await c.phase('before-commit'); c.signal('SIGTERM');
  await c.phase('timeout'); expect((await c.done).code).toBe(1);
  expect(c.records.some(r => r.phase === 'acked' || r.phase === 'drained' || r.phase === 'pool-close-started')).toBe(false);
  expect((await snapshot(wallet.id)).balance).toBe('100.00');
  const restarted = await child('consumer-normal'); restarted.start(); await restarted.phase('acked'); await stop(restarted);
  expect((await snapshot(wallet.id)).debit).toBe('1'); await reconcile(wallet.id, '90.00');
}, 25000);
test('50 duplicates delivered across distinct FIFO groups and three real consumers have one financial effect', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const payload = body(request(wallet));
  const children: ResilienceClient[] = [];
  for (let i = 0; i < 3; i++) children.push(await child('consumer-normal'));
  expect(new Set(children.map(c => c.pid)).size).toBe(3); expect(new Set(children.map(c => c.backendPid)).size).toBe(3);
  expect(children.every(c => Number.isInteger(c.backendPid))).toBe(true);
  console.log('CP-05 process identities:', JSON.stringify(children.map(c => ({ pid: c.pid, backendPid: c.backendPid }))));
  await Promise.all(Array.from({ length: 50 }, (_, i) => h.sqs.send(payload, `delivery-${i}`))); children.forEach(c => c.start());
  await waitUntil(() => children.flatMap(c => c.records).filter(r => r.phase === 'acked').length >= 50, 30000);
  await Promise.all(children.map(stop));
  const commits = children.flatMap(c => c.records).filter(r => r.phase === 'committed');
  expect(commits).toHaveLength(50); expect(commits.filter(r => !r.replay)).toHaveLength(1); expect(commits.filter(r => r.replay)).toHaveLength(49);
  expect(children.every(c => c.records.some(r => r.phase === 'committed'))).toBe(true);
  expect(await snapshot(wallet.id)).toEqual({ debit: '1', ledger: '2', inbox: '1', outbox: '4', balance: '90.00', version: 2 });
  expect(await h.sqs.transport.receive()).toBeUndefined(); await reconcile(wallet.id, '90.00');
}, 60000);
test.each(['publisher-after-claim','publisher-after-send'] as const)('SIGKILL %s and restart recover real persisted Outbox without event loss', async mode => {
  const h = ctx(); const wallet = await h.pg.wallet(); const original = await h.pg.orm.em.fork().execute<{ id: string }[]>('select id from outbox_messages');
  const c = await child(mode); c.start(); const phase = await c.phase(mode === 'publisher-after-claim' ? 'claim-committed' : 'send-confirmed');
  c.signal('SIGKILL'); expect((await c.done).signal).toBe('SIGKILL'); expect(c.records.some(r => r.phase === 'drained')).toBe(false);
  const [persisted] = await h.pg.orm.em.fork().execute<{ published_at: string | null; lease_owner: string }[]>('select published_at,lease_owner from outbox_messages where id=?', [phase.eventId]);
  expect(persisted?.published_at).toBeNull(); expect(persisted?.lease_owner).toBe(`resilience-${c.pid}`);
  const restarted = await child('publisher-normal', new Date(epoch.getTime() + 10001)); restarted.start(); await waitUntil(published); await stop(restarted);
  expect(await eventIds(2)).toEqual(new Set(original.map(r => r.id))); await reconcile(wallet.id, '100.00');
}, 25000);
test('SIGTERM after publisher send preserves pool until fenced SQL confirmation, then restart publishes remaining events', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const c = await child('publisher-after-send'); c.start(); const sent = await c.phase('send-confirmed');
  c.signal('SIGTERM'); await c.phase('drain-started'); c.release(); await c.phase('published'); await c.phase('pool-closed'); await c.done; assertGraceful(c);
  const [row] = await h.pg.orm.em.fork().execute<{ published_at: string | null }[]>('select published_at from outbox_messages where id=?', [sent.eventId]);
  expect(row?.published_at).not.toBeNull();
  const restarted = await child('publisher-normal'); restarted.start(); await waitUntil(published); await stop(restarted);
  expect((await eventIds(2)).size).toBe(2); await reconcile(wallet.id, '100.00');
}, 20000);
test('SIGTERM pending worker drains one transaction with real pool open and restart resolves remaining candidate', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  const processor = new ProcessWagerTransactionUseCase(h.pg.uow, { now: () => epoch, pendingReferencePolicy: pendingReferencePolicy({}) });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const bet = request(wallet);
    const pending = await processor.execute(request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    ids.push(pending.transactionId); await processor.execute(bet);
  }
  const now = new Date(epoch.getTime() + 1000); const c = await child('pending-before-commit', now); c.start(); await c.phase('pending-before-commit');
  c.signal('SIGTERM'); await c.phase('drain-started'); c.release(); await c.phase('pending-resolved'); await c.phase('pool-closed'); await c.done; assertGraceful(c);
  expect(c.records.filter(r => r.phase === 'pending-resolved')).toHaveLength(1);
  expect(c.records.find(r => r.phase === 'pool-close-started')?.activeProcessor).toBe(false);
  const states = await Promise.all(ids.map(id => h.pg.uow.run(s => s.getWager(id))));
  expect(states.filter(t => t?.status === WagerTransactionStatus.Processed)).toHaveLength(1);
  const restarted = await child('pending-normal', now); restarted.start();
  await waitUntil(async () => (await Promise.all(ids.map(id => h.pg.uow.run(s => s.getWager(id))))).every(t => t?.status === WagerTransactionStatus.Processed));
  await stop(restarted); expect((await snapshot(wallet.id)).ledger).toBe('5'); await reconcile(wallet.id, '100.00');
}, 25000);
test('explicit FIFO deduplication inside the window is verified separately from persistent financial idempotency', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const payload = body(request(wallet)); const dedup = randomUUID();
  await h.sqs.send(payload, 'fifo-probe', dedup); await h.sqs.send(payload, 'fifo-probe', dedup);
  const message = await h.sqs.receiveSource();
  const consumer = new SqsWagerConsumer(h.pg.process, h.sqs.transport, new SystemClock(), h.sqs.config, () => {});
  expect((await consumer.handle(message)).action).toBe('acked'); expect(await h.sqs.transport.receive()).toBeUndefined();
  expect((await snapshot(wallet.id)).debit).toBe('1'); await reconcile(wallet.id, '90.00');
});

test('settled rollback during SIGTERM releases visibility immediately and never ACKs an unconfirmed operation', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); await h.sqs.send(body(request(wallet)));
  const c = await child('consumer-failure-on-stop'); c.start(); await c.phase('before-commit');
  c.signal('SIGTERM'); await c.phase('drain-started'); c.release(); await c.phase('visibility-released'); await c.phase('pool-closed'); await c.done; assertGraceful(c);
  expect(c.records.some(r => r.phase === 'committed' || r.phase === 'acked')).toBe(false);
  expect(await snapshot(wallet.id)).toEqual({ debit: '0', ledger: '1', inbox: '0', outbox: '2', balance: '100.00', version: 1 });
  const restarted = await child('consumer-normal'); restarted.start(); await restarted.phase('acked'); await stop(restarted);
  expect((await snapshot(wallet.id)).debit).toBe('1'); await reconcile(wallet.id, '90.00');
}, 25000);
