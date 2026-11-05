import 'reflect-metadata';
import { expect, spyOn, test } from 'bun:test';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { ProviderIdentityGuard } from '../../src/shared/infrastructure/provider-identity.guard';
import type { FinancialUnitOfWork } from '../../src/shared/application/financial-store';

// Injection contract established in RED and implemented in GREEN.
// Existing register({ uow }) remains supported without a PostgreSQL probe.
// A probe resolves only on success and must observe the supplied cancellation signal.
type Probe = (signal: AbortSignal) => Promise<void>;
type Options = Parameters<typeof AppModule.register>[0] & { health?: { postgres?: Probe; sqs?: Probe } };
const ready = { status: 'ready', dependencies: { postgres: 'up', sqs: 'up' } };
const draining = { status: 'draining', dependencies: { postgres: 'unknown', sqs: 'unknown' } };
const unavailable: Probe = async () => { throw new Error('private postgres://user:password SQL stack'); };
const available: Probe = async () => {};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function start(health?: Options['health'], timeout = '1500', root?: (options: Options) => DynamicModule) {
  const previous = { database: process.env['DATABASE_URL'], timeout: process.env['HEALTH_READINESS_TIMEOUT_MS'] };
  delete process.env['DATABASE_URL']; process.env['HEALTH_READINESS_TIMEOUT_MS'] = timeout;
  let financialCalls = 0;
  const uow: FinancialUnitOfWork = { async run() { financialCalls++; throw new Error('Financial UoW must not be a health probe'); } };
  const options: Options = { uow, ...(health === undefined ? {} : { health }) };
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(root ? root(options) : AppModule.register(options), { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), financialCalls: () => financialCalls };
  } catch (error) { await app?.close(); throw error; }
  finally {
    if (previous.database === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous.database;
    if (previous.timeout === undefined) delete process.env['HEALTH_READINESS_TIMEOUT_MS']; else process.env['HEALTH_READINESS_TIMEOUT_MS'] = previous.timeout;
  }
}

test('[RED-A01] live has exact public contract with no SQL/SQS/financial authentication', async () => {
  let probes = 0;
  const probe: Probe = async () => { probes++; throw new Error('unavailable'); };
  const init = spyOn(MikroORM, 'init'); const send = spyOn(SQSClient.prototype, 'send');
  const guard = spyOn(ProviderIdentityGuard.prototype, 'canActivate').mockReturnValue(false);
  let h: Awaited<ReturnType<typeof start>> | undefined;
  try {
    h = await start({ postgres: probe, sqs: probe });
    const response = await fetch(`${h.url}/health/live`);
    // Assert non-I/O invariants before route status: baseline already satisfies these.
    expect(probes).toBe(0); expect(h.financialCalls()).toBe(0);
    expect(init).toHaveBeenCalledTimes(0); expect(send).toHaveBeenCalledTimes(0); expect(guard).toHaveBeenCalledTimes(0);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'ok' });
  } finally { await h?.app.close(); init.mockRestore(); send.mockRestore(); guard.mockRestore(); }
});
for (const query of ['?unknown=1', '?x=', '?x=1&x=2', '?x[]=1']) {
  test(`[RED-A01/A03] both health routes reject query ${query} before probes`, async () => {
    let calls = 0; const probe: Probe = async () => { calls++; };
    const h = await start({ postgres: probe, sqs: probe });
    try {
      const responses = await Promise.all(['live', 'ready'].map(path => fetch(`${h.url}/health/${path}${query}`)));
      expect(calls).toBe(0); expect(h.financialCalls()).toBe(0);
      expect(responses.map(r => r.status)).toEqual([400, 400]);
    } finally { await h.app.close(); }
  });
}
test('[RED-A06 PASS-existing] injected UoW has no ORM, implicit connection or workers', async () => {
  const init = spyOn(MikroORM, 'init'); const h = await start();
  try {
    const modules = [...h.app.get(ModulesContainer).values()];
    expect(modules.flatMap(m => [...m.providers.keys()]).filter(key => key === CoreORM)).toHaveLength(0);
    expect(modules.flatMap(m => [...m.providers.values()]).filter(p => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(p.metatype?.name ?? ''))).toHaveLength(0);
    expect(init).toHaveBeenCalledTimes(0); expect(h.financialCalls()).toBe(0);
    expect((await fetch(h.url)).status).toBe(404);
  } finally { await h.app.close(); init.mockRestore(); }
});
test('[RED-A03/A06] absent DATABASE_URL and no explicit probe is not ready', async () => {
  const h = await start();
  try {
    const response = await fetch(`${h.url}/health/ready`);
    expect(h.financialCalls()).toBe(0); expect(response.status).toBe(503);
    const body = await response.json() as { status: string; dependencies: { postgres: string } };
    expect(body.status).toBe('not_ready'); expect(body.dependencies.postgres).toBe('down');
  } finally { await h.app.close(); }
});
test('[RED-A06] explicitly injected probes are awaited and financial guard is bypassed', async () => {
  const calls: string[] = []; const guard = spyOn(ProviderIdentityGuard.prototype, 'canActivate').mockReturnValue(false);
  const h = await start({ postgres: async () => { calls.push('postgres'); }, sqs: async () => { calls.push('sqs'); } });
  try {
    expect(calls).toEqual([]); // No probe I/O at bootstrap.
    const response = await fetch(`${h.url}/health/ready`);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(ready);
    expect(calls.sort()).toEqual(['postgres', 'sqs']); expect(guard).toHaveBeenCalledTimes(0); expect(h.financialCalls()).toBe(0);
  } finally { await h.app.close(); guard.mockRestore(); }
});
for (const dependency of ['postgres', 'sqs'] as const) {
  test(`[RED-A03] ${dependency} failure is sanitized and does not break liveness`, async () => {
    const h = await start({ postgres: available, sqs: available, [dependency]: unavailable });
    try {
      const response = await fetch(`${h.url}/health/ready`); expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toEqual({ status: 'not_ready', dependencies: { postgres: dependency === 'postgres' ? 'down' : 'up', sqs: dependency === 'sqs' ? 'down' : 'up' } });
      expect(JSON.stringify(body)).not.toMatch(/password|postgres:\/\/|SQL|stack/);
      expect((await fetch(`${h.url}/health/live`)).status).toBe(200);
    } finally { await h.app.close(); }
  });
}
for (const dependency of ['postgres', 'sqs'] as const) {
  test(`[RED-A03] ${dependency} timeout cancels cooperative probe within total budget`, async () => {
    let aborted = false;
    const blocked: Probe = signal => new Promise((_resolve, reject) => {
      const abort = () => { aborted = true; reject(new Error('cancelled')); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    const h = await start({ postgres: available, sqs: available, [dependency]: blocked }, '100');
    try {
      const at = performance.now(); const response = await fetch(`${h.url}/health/ready`);
      expect(response.status).toBe(503); expect(performance.now() - at).toBeLessThan(1000);
      expect(aborted).toBe(true);
    } finally { await h.app.close(); }
  });
}
for (const timeout of ['99', '10001', '0', '-1', '1.5', '1e3', '', ' 1500', '1500 ', 'NaN']) {
  test(`[RED-A03] invalid HEALTH_READINESS_TIMEOUT_MS=${JSON.stringify(timeout)} fails configuration`, async () => {
    let h: Awaited<ReturnType<typeof start>> | undefined; let failure: unknown;
    try { h = await start({ postgres: available, sqs: available }, timeout); } catch (error) { failure = error; }
    finally { await h?.app.close(); }
    expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain('HEALTH_READINESS_TIMEOUT_MS');
  });
}
test('[RED-A04] twenty requests share one pending operation even after HTTP timeout', async () => {
  const entered = deferred(); const release = deferred(); const settled = deferred(); let calls = 0;
  const postgres: Probe = async () => { calls++; entered.resolve(); try { await release.promise; } finally { settled.resolve(); } };
  const h = await start({ postgres, sqs: available }, '100');
  const request = () => fetch(`${h.url}/health/ready`);
  const batch = Promise.all(Array.from({ length: 20 }, request));
  try {
    await Promise.race([entered.promise, batch]);
    expect(calls).toBe(1); // Baseline fails here without hanging on the unentered barrier.
    expect((await batch).map(r => r.status)).toEqual(Array(20).fill(503));
    expect((await request()).status).toBe(503); expect(calls).toBe(1);
    release.resolve(); await settled.promise; await new Promise<void>(resolve => setImmediate(resolve));
    expect((await request()).status).toBe(200); expect(calls).toBe(2);
  } finally { release.resolve(); await batch; await h.app.close(); }
});
@Module({}) class ShutdownTestModule {}
test('[RED-A07] draining is visible before server/resource close and suppresses healthy late results', async () => {
  const probeEntered = deferred(); const releaseProbe = deferred(); const before = deferred(); const releaseShutdown = deferred();
  let calls = 0; let resourceCloses = 0;
  const h = await start({ postgres: async signal => { calls++; probeEntered.resolve(); const abort = () => releaseProbe.resolve(); signal.addEventListener('abort', abort, { once: true }); try { await releaseProbe.promise; } finally { signal.removeEventListener('abort', abort); } }, sqs: available }, '100', options => ({
    module: ShutdownTestModule, imports: [AppModule.register(options)], providers: [{ provide: Symbol('shutdown-checkpoint'), useValue: {
      async beforeApplicationShutdown() { before.resolve(); await releaseShutdown.promise; },
      onApplicationShutdown() { resourceCloses++; },
    } }],
  }));
  let closing: Promise<void> | undefined;
  const pending = fetch(`${h.url}/health/ready`);
  try {
    await Promise.race([probeEntered.promise, pending]);
    closing = h.app.close(); await before.promise;
    const during = await fetch(`${h.url}/health/ready`);
    expect(resourceCloses).toBe(0); expect(during.status).toBe(503); expect(await during.json()).toEqual(draining);
    const afterDrainingCalls = calls; releaseProbe.resolve();
    expect((await pending).status).toBe(503);
    expect((await fetch(`${h.url}/health/ready`)).status).toBe(503); expect(calls).toBe(afterDrainingCalls);
    expect((await fetch(`${h.url}/health/live`)).status).toBe(200);
  } finally { releaseProbe.resolve(); releaseShutdown.resolve(); await pending; if (closing) await closing; else await h.app.close(); }
  expect(resourceCloses).toBe(1);
});

import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { localSqsClient } from '../../src/modules/messaging/infrastructure/local-sqs-client';
test('[RED-A03 EXPERIMENT] installed AWS SDK abort closes a stalled HTTP request', async () => {
  const entered = deferred(); const disconnected = deferred(); const sockets = new Set<Socket>();
  const server = createServer((_req, _res) => { entered.resolve(); /* Controlled unresponsive endpoint, no queue changes. */ });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket); disconnected.resolve(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected test socket');
  const client = localSqsClient({ SQS_ENDPOINT: `http://127.0.0.1:${address.port}` }); const stop = new AbortController();
  const outcome = client.send(new GetQueueUrlCommand({ QueueName: 'read-only-diagnostic.fifo' }), { abortSignal: stop.signal })
    .then(() => 'completed', error => (error as Error).name);
  try {
    await entered.promise; stop.abort(); expect(await outcome).toBe('AbortError');
    await disconnected.promise; expect(sockets.size).toBe(0);
  } finally { stop.abort(); client.destroy(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
