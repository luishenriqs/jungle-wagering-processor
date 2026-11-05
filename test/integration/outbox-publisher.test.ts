import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, type Harness } from '../support/postgres';
import { createOutboxSqsHarness, type OutboxSqsHarness } from '../support/outbox-sqs';
import { publisherChild } from '../support/outbox-publisher-client';
import { OutboxPublisher, type OutboxTransport } from '../../src/modules/messaging/application/outbox-publisher';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
import type { OutboxRecord, PostgresRow } from '../../src/database/records';
import type { FinancialUnitOfWork } from '../../src/shared/application/financial-store';

let context: { pg: Harness; sqs: OutboxSqsHarness; now: Date } | undefined;
const epoch = new Date('2035-01-01T00:00:00Z');
beforeEach(async () => {
  const sqs = await createOutboxSqsHarness();
  try { context = { sqs, pg: await createHarness(), now: new Date(epoch) }; }
  catch (error) { await sqs.close(); throw error; }
}, 30000);
afterEach(async () => {
  const h = context; context = undefined;
  if (h) try { await h.sqs.close(); } finally { await h.pg.close(); }
}, 15000);
function ctx() { if (!context) throw new Error('Real PostgreSQL and SQS are required'); return context; }
function publisher(owner: string, transport: OutboxTransport = ctx().sqs.transport, uow = ctx().pg.uow) {
  return new OutboxPublisher(uow, transport, { now: () => new Date(ctx().now) }, workerConfig({}), { workerId: owner, diagnose: () => {} });
}
async function rows() { return ctx().pg.orm.em.fork().execute<PostgresRow<OutboxRecord>[]>('select * from outbox_messages order by next_attempt_at,occurred_at,id'); }
async function drain(p: OutboxPublisher) {
  const results = [];
  for (let i = 0; i < 1000; i++) {
    const result = await p.publishNext(); if (result.action === 'idle') return results;
    results.push(result); expect(result.action).toBe('published');
  }
  throw new Error('Outbox drain did not finish');
}
async function collectUnique(expected: number) {
  const received: Awaited<ReturnType<OutboxSqsHarness['read']>> = [];
  const deadline = Date.now() + 10000;
  do {
    received.push(...await ctx().sqs.read());
    if (new Set(received.map(e => e.payload['eventId'])).size >= expected) return received;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('Missing published events in real FIFO queue');
}
async function reconcile(walletId: string, amount = '100.00') {
  const result = await ctx().pg.reconcile.execute(walletId);
  expect(result.consistent).toBe(true); expect(result.storedBalance.amount).toBe(amount);
}

test('claim commits and releases row lock before actual SQS send; event envelope stays unchanged', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const original = await rows();
  const sender: OutboxTransport = { publish: async (message, signal) => {
    await h.pg.orm.em.fork().transactional(async em => {
      // NOWAIT would fail if the claim transaction still held this event's row lock.
      const [r] = await em.execute<PostgresRow<OutboxRecord>[]>('select * from outbox_messages where id=? for update nowait', [message.id]);
      expect(r?.lease_owner).toBe('publisher'); expect(r?.lease_token).toMatch(/^[a-f0-9-]{36}$/); expect(r?.published_at).toBeNull();
    });
    await h.sqs.transport.publish(message, signal);
  } };
  const p = publisher('publisher', sender); expect((await p.publishNext()).action).toBe('published');
  expect((await rows()).filter(r => r.published_at !== null)).toHaveLength(1);
  await drain(p); const events = await collectUnique(2);
  expect(new Set(events.map(e => e.payload['eventId']))).toEqual(new Set(original.map(r => r.id)));
  for (const event of events) {
    const row = original.find(r => r.id === event.payload['eventId'])!;
    expect(event.payload).toEqual(row.payload); expect(event.groupId).toBe(row.aggregate_id); expect(event.dedupId).toBe(row.id);
  }
  expect((await rows()).every(r => r.published_at !== null && r.lease_owner === null && r.lease_token === null && r.lease_until === null)).toBe(true);
  await reconcile(wallet.id);
});
test('three independent Bun publishers drain 100 events without loss and expose distinct PostgreSQL backends', async () => {
  const h = ctx(); const wallets = [];
  for (let i = 0; i < 50; i++) wallets.push(await h.pg.wallet('1.00'));
  const expected = await rows(); expect(expected).toHaveLength(100);
  const children: Awaited<ReturnType<typeof publisherChild>>[] = [];
  try {
    for (let i = 0; i < 3; i++) children.push(await publisherChild(h.pg, h.sqs.name, h.now));
    expect(new Set(children.map(c => c.pid)).size).toBe(3);
    expect(new Set(children.map(c => c.backendPid)).size).toBe(3);
    expect(children.every(c => Number.isInteger(c.backendPid))).toBe(true);
    console.log('CP-03 process identities:', JSON.stringify(children.map(c => ({ pid: c.pid, backendPid: c.backendPid }))));
    children.forEach(c => c.start());
    expect(await Promise.all(children.map(c => c.done))).toEqual([0, 0, 0]);
    expect(children.every(c => c.records.some(r => r.type === 'done' && (r.published ?? 0) > 0))).toBe(true);
    expect(children.flatMap(c => c.records).filter(r => r.type === 'done').reduce((n, r) => n + (r.published ?? 0), 0)).toBe(100);
    expect((await rows()).every(r => r.published_at !== null)).toBe(true);
    const events = await collectUnique(100);
    expect(new Set(events.map(e => e.payload['eventId']))).toEqual(new Set(expected.map(r => r.id)));
    for (const event of events) { expect(event.groupId).toBe(event.payload['aggregateId'] as string); expect(event.dedupId).toBe(event.payload['eventId'] as string); }
    for (const wallet of wallets) await reconcile(wallet.id, '1.00');
  } finally { await Promise.all(children.map(c => c.close())); }
}, 60000);
test('real process exits after committed claim; another publisher recovers when virtual lease expires', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  const child = await publisherChild(h.pg, h.sqs.name, h.now, 'crash-after-claim');
  try { child.start(); expect(await child.done).toBe(71); } finally { await child.close(); }
  const crashed = child.records.find(r => r.phase === 'claim-committed')!; expect(crashed.eventId).toBeDefined();
  expect(await h.sqs.read()).toHaveLength(0);
  const claimed = (await rows()).find(r => r.id === crashed.eventId)!; expect(claimed.published_at).toBeNull(); expect(claimed.lease_owner).toBe(`child-${child.pid}`);
  await drain(publisher('survivor')); // The other opening event can progress before expiration.
  expect((await rows()).find(r => r.id === crashed.eventId)?.published_at).toBeNull();
  h.now = new Date(epoch.getTime() + 10001);
  const recovered = await publisher('recovery').publishNext(); expect(recovered).toEqual({ action: 'published', eventId: crashed.eventId! });
  expect(new Set((await collectUnique(2)).map(e => e.payload['eventId'])).size).toBe(2);
  expect((await rows()).every(r => r.published_at !== null)).toBe(true); await reconcile(wallet.id);
});
test('real process exits after accepted publish; retry preserves eventId and eventually confirms SQL', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  const child = await publisherChild(h.pg, h.sqs.name, h.now, 'crash-after-publish');
  try { child.start(); expect(await child.done).toBe(72); } finally { await child.close(); }
  const crashed = child.records.find(r => r.phase === 'send-confirmed')!; expect(crashed.eventId).toBeDefined();
  expect((await rows()).find(r => r.id === crashed.eventId)?.published_at).toBeNull();
  const retried: string[] = [];
  h.now = new Date(epoch.getTime() + 10001);
  const sender: OutboxTransport = { publish: async (m, signal) => { retried.push(m.id); await h.sqs.transport.publish(m, signal); } };
  await drain(publisher('recovery', sender)); expect(retried).toContain(crashed.eventId!);
  const events = await collectUnique(2); expect(new Set(events.map(e => e.payload['eventId'])).size).toBe(2);
  expect((await rows()).every(r => r.published_at !== null)).toBe(true); await reconcile(wallet.id);
  // Duplicates are permitted. This test does not rely on FIFO delivering a second copy inside its dedup window.
});
test('send accepted by real SQS but confirmation times out; backoff retry keeps the same eventId', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); let accepted: string | undefined;
  const sender: OutboxTransport = { publish: async (m, signal) => {
    await h.sqs.transport.publish(m, signal); accepted = m.id;
    await new Promise<void>((_resolve, reject) => {
      const abort = () => { const error = new Error('injected lost response'); error.name = 'AbortError'; reject(error); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  } };
  const p = new OutboxPublisher(h.pg.uow, sender, { now: () => h.now }, workerConfig({}), { workerId: 'timeout', diagnose: () => {} });
  expect((await p.publishNext()).action).toBe('retry-scheduled'); expect(accepted).toBeDefined();
  const row = (await rows()).find(r => r.id === accepted)!;
  expect(row.attempts).toBe(1); expect(row.published_at).toBeNull(); expect(row.lease_owner).toBeNull(); expect(row.last_error).toBe('SQS_SEND_TIMEOUT');
  await drain(publisher('other')); h.now = new Date(epoch.getTime() + 1000);
  expect(await publisher('retry').publishNext()).toEqual({ action: 'published', eventId: accepted! });
  expect(new Set((await collectUnique(2)).map(e => e.payload['eventId'])).size).toBe(2);
  await reconcile(wallet.id);
}, 15000);
test('late confirmation from old owner cannot overwrite a newer completed claim', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const old = publisher('old', { publish: async (m, signal) => { entered(); await gate; await h.sqs.transport.publish(m, signal); } }).publishNext();
  try {
    await ready; h.now = new Date(epoch.getTime() + 10001);
    const winner = await publisher('new').publishNext(); expect(winner.action).toBe('published');
    release(); expect((await old).action).toBe('lease-lost');
    const row = (await rows()).find(r => winner.action !== 'idle' && r.id === winner.eventId)!;
    expect(row.published_at).not.toBeNull(); expect(row.attempts).toBe(0); expect(row.lease_owner).toBeNull();
    await drain(publisher('drain')); await collectUnique(2); await reconcile(wallet.id);
  } finally { release(); await old; }
});
test('late failure cannot clear or reschedule the lease held by a new owner', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  let enteredOld!: () => void; let enteredNew!: () => void; let releaseOld!: () => void; let releaseNew!: () => void;
  const oldReady = new Promise<void>(r => { enteredOld = r; }); const newReady = new Promise<void>(r => { enteredNew = r; });
  const oldGate = new Promise<void>(r => { releaseOld = r; }); const newGate = new Promise<void>(r => { releaseNew = r; });
  const old = publisher('old', { publish: async () => { enteredOld(); await oldGate; throw new Error('old send failed'); } }).publishNext();
  let next: Promise<Awaited<ReturnType<OutboxPublisher['publishNext']>>> | undefined;
  try {
    await oldReady; h.now = new Date(epoch.getTime() + 10001);
    next = publisher('new', { publish: async (m, signal) => { enteredNew(); await newGate; await h.sqs.transport.publish(m, signal); } }).publishNext();
    await newReady;
    const owned = (await rows()).find(r => r.lease_owner === 'new')!; expect(owned).toBeDefined();
    releaseOld(); expect((await old).action).toBe('lease-lost');
    const preserved = (await rows()).find(r => r.id === owned.id)!;
    expect(preserved.lease_owner).toBe('new'); expect(preserved.lease_token).toBe(owned.lease_token); expect(preserved.attempts).toBe(0);
    releaseNew(); expect((await next).action).toBe('published'); await drain(publisher('drain')); await collectUnique(2); await reconcile(wallet.id);
  } finally { releaseOld(); releaseNew(); await old; await next; }
});
test('SQL confirmation outage after real SQS acceptance recovers through lease expiration', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); let runs = 0;
  const uow: FinancialUnitOfWork = { run: async (work, isolation) => {
    if (++runs === 2) throw new Error('injected SQL confirmation outage');
    return h.pg.uow.run(work, isolation);
  } };
  const outcome = await new OutboxPublisher(uow, h.sqs.transport, { now: () => h.now }, workerConfig({}), { workerId: 'outage', diagnose: () => {} }).publishNext();
  expect(outcome.action).toBe('confirmation-pending');
  if (outcome.action === 'idle') throw new Error('Expected a claimed event');
  const before = (await rows()).find(r => r.id === outcome.eventId)!; expect(before.published_at).toBeNull(); expect(before.lease_owner).toBe('outage');
  h.now = new Date(epoch.getTime() + 10001); await drain(publisher('recovery')); await collectUnique(2);
  expect((await rows()).every(r => r.published_at !== null)).toBe(true); await reconcile(wallet.id);
});

test('uncommitted financial Outbox is invisible to publisher until the financial transaction commits', async () => {
  const h = ctx(); let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const creation = new CreateWalletUseCase(h.pg.uow, { checkpoint: async phase => {
    if (phase === 'outbox') { entered(); await gate; }
  } }).execute({ playerId: `player-${randomUUID()}`, initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: randomUUID() });
  try {
    await ready;
    expect(await publisher('before-commit').publishNext()).toEqual({ action: 'idle' });
    expect(await h.sqs.read()).toHaveLength(0);
    release(); const wallet = await creation;
    await drain(publisher('after-commit')); await collectUnique(2); await reconcile(wallet.id);
  } finally { release(); await creation; }
});
test('configured exponential retry survives SQL rehydration, respects its ceiling and eventually publishes', async () => {
  const h = ctx(); const wallet = await h.pg.wallet();
  const config = workerConfig({ OUTBOX_BASE_RETRY_MS: '10', OUTBOX_MAX_RETRY_MS: '20' });
  const failing = new OutboxPublisher(h.pg.uow, { publish: async () => { throw new Error('injected unavailable transport'); } },
    { now: () => h.now }, config, { workerId: 'backoff', diagnose: () => {} });
  let id: string | undefined;
  for (const delay of [10, 20, 20]) {
    const result = await failing.publishNext(); expect(result.action).toBe('retry-scheduled');
    if (result.action === 'idle') throw new Error('Expected retryable event');
    if (id === undefined) { id = result.eventId; await drain(publisher('other-event')); }
    expect(result.eventId).toBe(id);
    const row = (await rows()).find(r => r.id === id)!;
    expect(new Date(row.next_attempt_at).getTime() - h.now.getTime()).toBe(delay);
    expect(row.published_at).toBeNull(); expect(row.lease_owner).toBeNull();
    h.now = new Date(h.now.getTime() + delay);
  }
  const before = (await rows()).find(r => r.id === id)!; expect(before.attempts).toBe(3);
  expect(await publisher('recovered').publishNext()).toEqual({ action: 'published', eventId: id! });
  await collectUnique(2); await reconcile(wallet.id);
});
