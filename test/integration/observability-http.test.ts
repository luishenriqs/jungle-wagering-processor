import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { Module, type INestApplication } from '@nestjs/common';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { databaseConfig } from '../../src/database/config';
import { testDatabaseUrl } from '../support/postgres';
import { createSqsHarness, type SqsHarness } from '../support/sqs';
import { createOutboxSqsHarness, type OutboxSqsHarness } from '../support/outbox-sqs';
import { AwsSqsConsumerTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-consumer-transport';
import { AwsSqsOutboxTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-outbox-transport';
import { sqlError } from '../../src/shared/application/application-errors';
import type { FinancialUnitOfWork } from '../../src/shared/application/financial-store';

type Probe = (signal: AbortSignal) => Promise<void>;
type Options = Parameters<typeof AppModule.register>[0] & { health?: { postgres?: Probe; sqs?: Probe } };
let orm: MikroORM; let queues: SqsHarness; let events: OutboxSqsHarness;
// Dedicated read-only experiment pool. Do NOT call createHarness(): it runs migrations.
// No schema/table is needed for SELECT 1, pg_settings, pg_sleep or transaction settings.
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(testDatabaseUrl()));
  try { queues = await createSqsHarness(); events = await createOutboxSqsHarness(); }
  catch (error) { await queues?.close(); await orm.close(true); throw error; }
}, 20000);
afterAll(async () => { try { await events?.close(); } finally { try { await queues?.close(); } finally { await orm?.close(true); } } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function start(postgres: Probe, changes: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    DATABASE_URL: undefined, SQS_INPUT_QUEUE_NAME: queues.inputName, SQS_DLQ_QUEUE_NAME: queues.dlqName,
    SQS_EVENTS_QUEUE_NAME: events.name, SQS_MAX_RECEIVE_COUNT: String(queues.config.maxReceiveCount),
    HEALTH_READINESS_TIMEOUT_MS: '1500', ...changes,
  };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  let app: INestApplication | undefined;
  try {
    const uow: FinancialUnitOfWork = { async run() { throw new Error('Health must not execute financial UoW'); } };
    const options: Options = { uow, health: { postgres } };
    app = await NestFactory.create(AppModule.register(options), { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), async close() { try { await app!.close(); } finally { restore(); } } };
  } catch (error) { await app?.close(); restore(); throw error; }
  function restore() { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const postgres: Probe = async () => {
  expect(await orm.em.getConnection().execute('select 1 as healthy')).toEqual([{ healthy: 1 }]);
};
async function topology(input = queues.inputName, dlq = queues.dlqName, eventQueue = events.name) {
  await AwsSqsConsumerTransport.connect(queues.client, queues.config, input, dlq);
  await AwsSqsOutboxTransport.connect(queues.client, 1500, eventQueue);
}

test('[RED-A02 EXPERIMENT] real PostgreSQL and three isolated FIFO queues have correct topology', async () => {
  expect(await orm.em.getConnection().execute('select current_database() as database')).toEqual([{ database: 'jungle_test' }]);
  await postgres(new AbortController().signal); await topology();
  const attrs = await queues.client.send(new GetQueueAttributesCommand({ QueueUrl: queues.dlqUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
  expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('0'); expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
});
test('[RED-A02] readiness uses effective SQL and real SQS validation before HTTP 200', async () => {
  await topology(); await postgres(new AbortController().signal); // Baseline environment is positively verified independently of the missing route.
  let sqlCalls = 0; const calls: string[] = [];
  const send = SQSClient.prototype.send;
  const observe = spyOn(SQSClient.prototype, 'send').mockImplementation(function(this: SQSClient, ...args: Parameters<typeof send>) {
    calls.push(args[0].constructor.name); return Reflect.apply(send, this, args);
  } as typeof send);
  const h = await start(async signal => { sqlCalls++; await postgres(signal); });
  try {
    expect(calls).toEqual([]); expect(sqlCalls).toBe(0); // No readiness network I/O at startup.
    const response = await fetch(`${h.url}/health/ready`); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', dependencies: { postgres: 'up', sqs: 'up' } });
    expect(sqlCalls).toBe(1);
    expect(calls.filter(c => c === 'GetQueueUrlCommand')).toHaveLength(3);
    expect(calls.filter(c => c === 'GetQueueAttributesCommand')).toHaveLength(3);
    expect(calls.every(c => ['GetQueueUrlCommand', 'GetQueueAttributesCommand'].includes(c))).toBe(true);
  } finally { await h.close(); observe.mockRestore(); }
});
for (const scenario of ['missing', 'non-fifo', 'wrong-redrive', 'wrong-dlq', 'sqs-unreachable'] as const) {
  test(`[RED-A03] real SQS negative ${scenario} yields sanitized 503`, async () => {
    const changes: Record<string, string> = {}; let extraUrl: string | undefined;
    try {
      if (scenario === 'missing') {
        changes['SQS_EVENTS_QUEUE_NAME'] = `${queues.prefix}_missing.fifo`;
        await expect(topology(queues.inputName, queues.dlqName, changes['SQS_EVENTS_QUEUE_NAME'])).rejects.toThrow();
      } else if (scenario === 'non-fifo') {
        const name = `${queues.prefix}_standard`;
        extraUrl = (await queues.client.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl;
        expect(extraUrl).toBeDefined();
        const attrs = await queues.client.send(new GetQueueAttributesCommand({ QueueUrl: extraUrl!, AttributeNames: ['FifoQueue'] }));
        expect(attrs.Attributes?.FifoQueue).not.toBe('true'); changes['SQS_EVENTS_QUEUE_NAME'] = name;
      } else if (scenario === 'wrong-redrive') {
        const arn = (await queues.client.send(new GetQueueAttributesCommand({ QueueUrl: queues.dlqUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
        const name = `${queues.prefix}_wrong.fifo`;
        extraUrl = (await queues.client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(queues.config.maxReceiveCount + 1) }) } }))).QueueUrl;
        expect(extraUrl).toBeDefined(); changes['SQS_INPUT_QUEUE_NAME'] = name;
        await expect(topology(name)).rejects.toThrow('SQS redrive policy/config mismatch');
      } else if (scenario === 'wrong-dlq') {
        changes['SQS_DLQ_QUEUE_NAME'] = events.name;
        await expect(topology(queues.inputName, events.name)).rejects.toThrow('SQS redrive policy/config mismatch');
      } else { changes['SQS_ENDPOINT'] = 'http://127.0.0.1:1'; }
      const h = await start(postgres, changes);
      try {
        const response = await fetch(`${h.url}/health/ready`); expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: 'not_ready', dependencies: { postgres: 'up', sqs: 'down' } });
        expect((await fetch(`${h.url}/health/live`)).status).toBe(200);
      } finally { await h.close(); }
    } finally { if (extraUrl) await queues.client.send(new DeleteQueueCommand({ QueueUrl: extraUrl }), { abortSignal: AbortSignal.timeout(3000) }); }
  });
}

test('[RED-A05 EXPERIMENT] saturated pool acquisition stays pending after response deadline, then abort cleans queue', async () => {
  const knex = orm.em.getConnection().getKnex(); const pool = knex.client.pool;
  const held = await Promise.all(Array.from({ length: pool.max }, () => knex.client.acquireConnection()));
  let acquisition: ReturnType<typeof pool.acquire> | undefined;
  try {
    expect(pool.numUsed()).toBe(pool.max); acquisition = pool.acquire();
    let settled = false; const outcome = acquisition.promise.then(() => { settled = true; return 'acquired'; }, () => { settled = true; return 'aborted'; });
    expect(pool.numPendingAcquires()).toBe(1);
    // Synthetic HTTP budget experiment only, not a readiness implementation.
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    expect(settled).toBe(false); expect(pool.numPendingAcquires()).toBe(1);
    acquisition.abort(); expect(await outcome).toBe('aborted'); expect(pool.numPendingAcquires()).toBe(0);
    console.log(JSON.stringify({ experiment: 'A05-acquire-abort', held: held.length, pendingAfterHttpDeadline: 1, pendingAfterAbort: pool.numPendingAcquires() }));
  } finally { acquisition?.abort(); await Promise.all(held.map(c => knex.client.releaseConnection(c))); }
  await postgres(new AbortController().signal); expect(pool.numUsed()).toBe(0); expect(pool.numPendingAcquires()).toBe(0);
});
test('[RED-A05 EXPERIMENT] abort/release races preserve ownership and pool recovery', async () => {
  const knex = orm.em.getConnection().getKnex(); const pool = knex.client.pool;
  const held = await Promise.all(Array.from({ length: pool.max }, () => knex.client.acquireConnection()));
  let acquired = 0; let aborted = 0;
  try {
    for (let i = 0; i < 20; i++) {
      const handle = pool.acquire(); const outcome = handle.promise.then((value: unknown) => ({ value }), () => undefined);
      const returned = held.pop()!;
      if (i % 2 === 0) { handle.abort(); await knex.client.releaseConnection(returned); }
      else { await knex.client.releaseConnection(returned); await handle.promise; handle.abort(); }
      const result = await outcome;
      if (result) { acquired++; await knex.client.releaseConnection(result.value); } else aborted++;
      expect(pool.numPendingAcquires()).toBe(0);
      held.push(await knex.client.acquireConnection()); expect(pool.numUsed()).toBe(pool.max);
    }
  } finally { await Promise.all(held.map(c => knex.client.releaseConnection(c))); }
  expect({ acquired, aborted }).toEqual({ acquired: 10, aborted: 10 });
  await postgres(new AbortController().signal); expect(pool.numUsed()).toBe(0);
  console.log(JSON.stringify({ experiment: 'A05-race', acquired, aborted, pending: pool.numPendingAcquires(), used: pool.numUsed() }));
});
test('[RED-A03/A05 EXPERIMENT] local statement_timeout stops SQL and rolls back technical read-only transaction', async () => {
  const knex = orm.em.getConnection().getKnex(); let failure: unknown;
  const previous = await knex.raw('show statement_timeout').then(r => r.rows); const at = performance.now();
  try { await knex.transaction(async trx => {
    await trx.raw('set transaction read only'); await trx.raw("set local statement_timeout='100ms'");
    await trx.raw('select pg_sleep(10)');
  }); } catch (error) { failure = error; }
  expect(sqlError(failure).code).toBe('57014'); expect(performance.now() - at).toBeLessThan(2000);
  await postgres(new AbortController().signal);
  expect(await knex.raw('show statement_timeout').then(r => r.rows)).toEqual(previous);
});
test('[RED-A05] HTTP timeout contains a saturated real pool acquisition until explicit cleanup', async () => {
  const knex = orm.em.getConnection().getKnex(); const pool = knex.client.pool;
  const held = await Promise.all(Array.from({ length: pool.max }, () => knex.client.acquireConnection()));
  const entered = deferred(); let calls = 0; let handle: ReturnType<typeof pool.acquire> | undefined;
  const h = await start(async () => {
    calls++; handle = pool.acquire(); entered.resolve(); // Deliberately uncooperative dependency: test requires coordinator containment.
    const connection = await handle.promise;
    try { await knex.raw('select 1').connection(connection); } finally { await knex.client.releaseConnection(connection); }
  }, { HEALTH_READINESS_TIMEOUT_MS: '100' });
  const started = performance.now();
  const batch = Promise.all(Array.from({ length: 20 }, () => fetch(`${h.url}/health/ready`)));
  try {
    await Promise.race([entered.promise, batch]); expect(calls).toBe(1);
    expect(pool.numPendingAcquires()).toBe(1); expect((await batch).every(r => r.status === 503)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    for (let i = 0; i < 3; i++) expect((await fetch(`${h.url}/health/ready`)).status).toBe(503);
    expect(calls).toBe(1); expect(pool.numPendingAcquires()).toBe(1);
    handle!.abort(); await Promise.all(held.splice(0).map(c => knex.client.releaseConnection(c)));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await fetch(`${h.url}/health/ready`)).status).toBe(200); expect(calls).toBe(2);
    expect(pool.numPendingAcquires()).toBe(0);
  } finally { handle?.abort(); await Promise.all(held.map(c => knex.client.releaseConnection(c))); await batch; await h.close(); }
  await postgres(new AbortController().signal); expect(pool.numPendingAcquires()).toBe(0);
});

@Module({}) class ShutdownOrmTestModule {}
test('[RED-A07] default HTTP graph reports draining while real ORM remains open, then closes once', async () => {
  const keys = ['DATABASE_URL', 'SQS_INPUT_QUEUE_NAME', 'SQS_DLQ_QUEUE_NAME', 'SQS_EVENTS_QUEUE_NAME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: testDatabaseUrl(), SQS_INPUT_QUEUE_NAME: queues.inputName, SQS_DLQ_QUEUE_NAME: queues.dlqName, SQS_EVENTS_QUEUE_NAME: events.name });
  const before = deferred(); const release = deferred();
  const app = await NestFactory.create({ module: ShutdownOrmTestModule, imports: [AppModule], providers: [{ provide: Symbol('before-close-checkpoint'), useValue: {
    async beforeApplicationShutdown() { before.resolve(); await release.promise; },
  } }] }, { logger: false, abortOnError: false });
  let closing: Promise<void> | undefined;
  const owned = app.get<MikroORM>(CoreORM); const close = spyOn(owned, 'close');
  try {
    await app.listen(0, '127.0.0.1'); const url = await app.getUrl();
    closing = app.close(); await before.promise;
    expect(await owned.isConnected()).toBe(true); expect(close).toHaveBeenCalledTimes(0);
    const response = await fetch(`${url}/health/ready`); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'draining', dependencies: { postgres: 'unknown', sqs: 'unknown' } });
  } finally {
    release.resolve(); if (closing) await closing; else await app.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    expect(close).toHaveBeenCalledTimes(1); close.mockRestore(); expect(await owned.isConnected()).toBe(false);
  }
});

test('[RED-A03] real PostgreSQL connection failure is readiness down without changing bootstrap', async () => {
  const address = new URL(testDatabaseUrl()); address.hostname = '127.0.0.1'; address.port = '1';
  const unreachable = await MikroORM.init({ ...databaseConfig(address.href), connect: false });
  try {
    await expect(unreachable.em.getConnection().execute('select 1')).rejects.toThrow();
    const h = await start(async () => { await unreachable.em.getConnection().execute('select 1'); });
    try {
      const response = await fetch(`${h.url}/health/ready`); expect(response.status).toBe(503);
      expect((await response.json() as { dependencies: { postgres: string } }).dependencies.postgres).toBe('down');
    } finally { await h.close(); }
  } finally { await unreachable.close(true); }
});

test('[RED-A05 EXPERIMENT] closing a probe-owned pg connection bounds client cleanup; server has its own statement deadline', async () => {
  const knex = orm.em.getConnection().getKnex(); const connection = await knex.client.acquireConnection();
  const pid = connection.processID as number; let closed = false; let released = false;
  try {
    // Session setting belongs only to this exclusively borrowed connection, which is
    // destroyed below rather than returned with altered settings. No global change.
    await knex.raw("set statement_timeout='500ms'").connection(connection);
    const outcome = knex.raw('select pg_sleep(10)').connection(connection).then(() => 'completed', () => 'rejected');
    let observed = false; const deadline = performance.now() + 2000;
    while (!observed && performance.now() < deadline) {
      const rows = await knex.raw("select wait_event from pg_stat_activity where pid=?", [pid]);
      observed = rows.rows[0]?.wait_event === 'PgSleep';
      if (!observed) await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(observed).toBe(true);
    const at = performance.now(); await knex.client.destroyRawConnection(connection); closed = true;
    expect(await outcome).toBe('rejected'); expect(performance.now() - at).toBeLessThan(1500);
    // Do not equate client rejection with immediate server cancellation.
    let backendGone = false; let observations = 0; const cleanupDeadline = performance.now() + 2000;
    while (!backendGone && performance.now() < cleanupDeadline) {
      const rows = await knex.raw('select pid from pg_stat_activity where pid=?', [pid]);
      backendGone = rows.rows.length === 0; observations++;
      if (!backendGone) await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(backendGone).toBe(true);
    connection.__knex__disposed = new Error('Experiment connection already closed');
    await knex.client.releaseConnection(connection); released = true;
    console.log(JSON.stringify({ experiment: 'A05-client-close', clientRejected: true, backendGone, serverObservations: observations }));
  } finally {
    if (!closed) await knex.client.destroyRawConnection(connection);
    if (!released) { connection.__knex__disposed = new Error('Closed test connection'); await knex.client.releaseConnection(connection); }
  }
  await postgres(new AbortController().signal); expect(knex.client.pool.numUsed()).toBe(0);
});

import { PostgresHealthProbe } from '../../src/shared/infrastructure/postgres-health.probe';
async function startDefaultHealth(timeout = '100') {
  const env = { DATABASE_URL: testDatabaseUrl(), HEALTH_READINESS_TIMEOUT_MS: timeout,
    SQS_INPUT_QUEUE_NAME: queues.inputName, SQS_DLQ_QUEUE_NAME: queues.dlqName, SQS_EVENTS_QUEUE_NAME: events.name,
    SQS_MAX_RECEIVE_COUNT: String(queues.config.maxReceiveCount) };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), owned: app.get<MikroORM>(CoreORM), async close() { try { await app!.close(); } finally { restore(); } } };
  } catch (error) { await app?.close(); restore(); throw error; }
  function restore() { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
test('[GREEN-A02] default composition uses its sole ORM for real SQL and SQS readiness', async () => {
  const h = await startDefaultHealth('1500');
  const query = h.owned.em.getConnection().getKnex(); const statements: string[] = [];
  const observe = (event: { sql: string }) => { statements.push(event.sql); };
  // Adapter queries pg directly on a connection from this exact pool; observe acquisition.
  let acquisitions = 0; const onAcquire = () => { acquisitions++; };
  query.client.pool.on('acquireRequest', onAcquire); query.on('query', observe);
  try {
    const modules = [...h.app.get(ModulesContainer).values()];
    expect(modules.filter(m => m.metatype.name === 'DatabaseModule')).toHaveLength(1);
    expect(modules.flatMap(m => [...m.providers.keys()]).filter(token => token === CoreORM)).toHaveLength(1);
    expect(modules.flatMap(m => [...m.providers.values()]).filter(p => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(p.metatype?.name ?? ''))).toHaveLength(0);
    const response = await fetch(`${h.url}/health/ready`); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', dependencies: { postgres: 'up', sqs: 'up' } });
    expect(acquisitions).toBe(1); expect(query.client.pool.numUsed()).toBe(0); expect(query.client.pool.numPendingAcquires()).toBe(0);
    expect((await query.raw('show statement_timeout')).rows).toEqual([{ statement_timeout: '0' }]);
    expect(statements.every(sql => !/wallets|wager_transactions|ledger|inbox|outbox/i.test(sql))).toBe(true);
  } finally { query.client.pool.removeListener('acquireRequest', onAcquire); query.removeListener('query', observe); await h.close(); }
});
test('[GREEN-A05] production adapter cancels saturated acquisition and serves recovered readiness', async () => {
  const h = await startDefaultHealth(); const knex = h.owned.em.getConnection().getKnex(); const pool = knex.client.pool;
  const held = await Promise.all(Array.from({ length: pool.max }, () => knex.client.acquireConnection()));
  let acquired = 0; const entered = deferred(); const onAcquire = () => { acquired++; entered.resolve(); };
  pool.on('acquireRequest', onAcquire);
  const started = performance.now(); const responses = Promise.all(Array.from({ length: 20 }, () => fetch(`${h.url}/health/ready`)));
  try {
    await entered.promise; expect(pool.numPendingAcquires()).toBe(1);
    expect((await responses).map(r => r.status)).toEqual(Array(20).fill(503));
    expect(performance.now() - started).toBeLessThan(1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(acquired).toBe(1); expect(pool.numPendingAcquires()).toBe(0); expect(pool.numUsed()).toBe(held.length);
    // Once cancellation actually settles, another timed-out round is permitted; still bounded to one acquire.
    const again = await fetch(`${h.url}/health/ready`); expect(again.status).toBe(503);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(acquired).toBe(2); expect(pool.numPendingAcquires()).toBe(0);
    await Promise.all(held.splice(0).map(c => knex.client.releaseConnection(c)));
    expect((await fetch(`${h.url}/health/ready`)).status).toBe(200); expect(acquired).toBe(3);
    expect(pool.numUsed()).toBe(0); expect(pool.numPendingAcquires()).toBe(0);
  } finally { pool.removeListener('acquireRequest', onAcquire); await Promise.all(held.map(c => knex.client.releaseConnection(c))); await responses; await h.close(); }
});
test('[GREEN-A05] production adapter server timeout discards a failed connection and recovers', async () => {
  const h = await startDefaultHealth('300'); const knex = h.owned.em.getConnection().getKnex();
  const connection = await knex.client.acquireConnection(); const query = connection.query.bind(connection);
  const entered = deferred(); let failureCode: string | undefined;
  const intercept = spyOn(connection, 'query').mockImplementation((...args: unknown[]) => {
    if (args[0] === 'SELECT 1 AS healthy') {
      entered.resolve();
      return query('SELECT pg_sleep(10), 1 AS healthy').catch((error: unknown) => { failureCode = sqlError(error).code; throw error; });
    }
    return Reflect.apply(query, connection, args);
  });
  await knex.client.releaseConnection(connection);
  try {
    const response = fetch(`${h.url}/health/ready`); await entered.promise;
    const result = await response; expect(result.status).toBe(503);
    expect((await result.json() as { dependencies: { postgres: string } }).dependencies.postgres).toBe('down');
    expect(failureCode).toBe('57014'); expect(connection.__knex__disposed).toBeTruthy();
    expect(knex.client.pool.numUsed()).toBe(0); expect(knex.client.pool.numPendingAcquires()).toBe(0);
    intercept.mockRestore();
    expect((await fetch(`${h.url}/health/ready`)).status).toBe(200);
    expect(knex.client.pool.numUsed()).toBe(0);
  } finally { intercept.mockRestore(); await h.close(); }
});
test('[GREEN-A05] production adapter handles abort before/after connection ownership without leaked loans', async () => {
  const h = await startDefaultHealth(); const knex = h.owned.em.getConnection().getKnex();
  const adapter = new PostgresHealthProbe(h.owned);
  try {
    const stopped = new AbortController(); stopped.abort(); await expect(adapter.check(stopped.signal)).rejects.toThrow();
    let count = 0; const abort = new AbortController();
    const onAcquire = () => { count++; abort.abort(); }; // Exact acquisition/listener-registration race.
    knex.client.pool.on('acquireRequest', onAcquire);
    try { await expect(adapter.check(abort.signal)).rejects.toThrow(); }
    finally { knex.client.pool.removeListener('acquireRequest', onAcquire); }
    expect(count).toBe(1); expect(knex.client.pool.numUsed()).toBe(0); expect(knex.client.pool.numPendingAcquires()).toBe(0);
    await adapter.check(new AbortController().signal); expect(knex.client.pool.numUsed()).toBe(0);
  } finally { await h.close(); }
});

import { createServer as createTcpServer } from 'node:net';
import type { Socket } from 'node:net';
test('[GREEN-A05] cancelled acquisition retains flight while a real pg connection is still being established', async () => {
  const sockets = new Set<Socket>(); const accepted = deferred();
  // Real TCP connection with deliberately stalled PostgreSQL handshake. No SQL,
  // credentials or messages are logged; only this disposable test socket is affected.
  const server = createTcpServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); accepted.resolve(); socket.resume(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP port');
  const target = new URL(testDatabaseUrl()); target.hostname = '127.0.0.1'; target.port = String(address.port);
  const configured = databaseConfig(target.href);
  const stalled = await MikroORM.init({ ...configured, connect: false, driverOptions: { ...configured.driverOptions,
    connection: { ...configured.driverOptions?.connection, connectionTimeoutMillis: 500 } } });
  const adapter = new PostgresHealthProbe(stalled); const finished = deferred(); let calls = 0;
  const h = await start(async signal => { calls++; try { await adapter.check(signal); } finally { finished.resolve(); } }, { HEALTH_READINESS_TIMEOUT_MS: '100' });
  const pool = stalled.em.getConnection().getKnex().client.pool;
  try {
    const pending = fetch(`${h.url}/health/ready`); await accepted.promise;
    expect((await pending).status).toBe(503); expect(pool.numPendingAcquires()).toBe(0);
    expect(pool.numPendingCreates()).toBe(1);
    expect((await fetch(`${h.url}/health/ready`)).status).toBe(503); expect(calls).toBe(1);
    await finished.promise; await new Promise<void>(resolve => setImmediate(resolve));
    expect(pool.numPendingCreates()).toBe(0); expect(pool.numPendingAcquires()).toBe(0); expect(pool.numUsed()).toBe(0);
    console.log(JSON.stringify({ experiment: 'production-acquire-creation', calls, pendingCreates: pool.numPendingCreates(), used: pool.numUsed() }));
  } finally {
    await h.close(); await stalled.close(true);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);
