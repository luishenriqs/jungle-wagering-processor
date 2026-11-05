import { expect, test } from 'bun:test';
import { WorkerShutdown, WorkerShutdownTimeoutError, shutdownTimeoutMs, type ShutdownDiagnostic } from '../../src/shared/application/worker-shutdown';
import { ConsumerLifecycle } from '../../src/modules/messaging/infrastructure/consumer-lifecycle';
import { PublisherLifecycle } from '../../src/modules/messaging/infrastructure/publisher-lifecycle';
import { PendingReferenceLifecycle } from '../../src/modules/wagering/infrastructure/pending-reference-lifecycle';

test('shutdown timeout is configurable and validates bounds', () => {
  expect(shutdownTimeoutMs({})).toBe(60000); expect(shutdownTimeoutMs({ WORKER_SHUTDOWN_TIMEOUT_MS: '200' })).toBe(200);
  for (const value of ['0','-1','NaN','1.5','1e3','300001','']) expect(() => shutdownTimeoutMs({ WORKER_SHUTDOWN_TIMEOUT_MS: value })).toThrow();
});
test('stop signal cancels polls, but drain waits for in-flight work and is idempotent', async () => {
  const phases: ShutdownDiagnostic[] = []; let finish!: () => void; let signal: AbortSignal | undefined;
  const task = new Promise<void>(resolve => { finish = resolve; });
  const shutdown = new WorkerShutdown('test', { timeoutMs: 1000, diagnose: e => phases.push(e) });
  shutdown.start(s => { signal = s; return task; });
  const first = shutdown.drain(); expect(shutdown.drain()).toBe(first); expect(signal?.aborted).toBe(true);
  await Promise.resolve(); expect(phases.map(e => e.phase)).toEqual(['drain-started']);
  finish(); await first; expect(phases.map(e => e.phase)).toEqual(['drain-started','drained']); shutdown.complete();
});
test('timeout requests hard termination and never reports graceful drainage', async () => {
  const phases: ShutdownDiagnostic[] = []; const exits: number[] = [];
  const shutdown = new WorkerShutdown('test', { timeoutMs: 5, forceExit: code => { exits.push(code); }, diagnose: e => phases.push(e) });
  shutdown.start(async () => new Promise<void>(() => {}));
  await expect(shutdown.drain()).rejects.toBeInstanceOf(WorkerShutdownTimeoutError);
  expect(exits).toEqual([1]); expect(phases.map(e => e.phase)).toEqual(['drain-started','timeout']);
});
test('failed loop produces sanitized failure and blocks normal resource shutdown', async () => {
  const events: ShutdownDiagnostic[] = []; const exits: number[] = [];
  const shutdown = new WorkerShutdown('test', { forceExit: code => { exits.push(code); }, diagnose: e => events.push(e) });
  shutdown.start(async () => { throw new Error('secret-not-to-log'); });
  await expect(shutdown.drain()).rejects.toThrow('Worker drain failed');
  expect(exits).toEqual([1]); expect(JSON.stringify(events)).not.toContain('secret-not-to-log');
});
test('cannot restart an instance after stop or start it twice', async () => {
  const shutdown = new WorkerShutdown('test', { diagnose: () => {} }); shutdown.start(async () => {});
  expect(() => shutdown.start(async () => {})).toThrow(); await shutdown.drain(); shutdown.complete(); expect(() => shutdown.start(async () => {})).toThrow();
});
test.each(['consumer','publisher','pending'] as const)('%s lifecycle waits in beforeApplicationShutdown before closing resources', async kind => {
  let finish!: () => void; let signal: AbortSignal | undefined; let closed = false; const phases: string[] = [];
  const task = new Promise<void>(resolve => { finish = resolve; });
  const runner = { run: async (s: AbortSignal) => { signal = s; await task; phases.push('operation-complete'); } };
  const client = { destroy: () => { closed = true; phases.push('client-close'); } };
  const options = { timeoutMs: 1000, diagnose: () => {} };
  const lifecycle = kind === 'consumer' ? new ConsumerLifecycle(runner, client, options)
    : kind === 'publisher' ? new PublisherLifecycle(runner, client, 250, options) : new PendingReferenceLifecycle(runner, 250, 100, options);
  lifecycle.onApplicationBootstrap(); const draining = lifecycle.beforeApplicationShutdown();
  expect(signal?.aborted).toBe(true); expect(closed).toBe(false);
  finish(); await draining;
  if ('onApplicationShutdown' in lifecycle) lifecycle.onApplicationShutdown();
  phases.push('pool-close'); lifecycle.completeShutdown();
  expect(phases.indexOf('operation-complete')).toBeLessThan(phases.indexOf('pool-close'));
  if (kind !== 'pending') expect(phases).toEqual(['operation-complete','client-close','pool-close']);
});
test('diagnostic failure cannot prevent graceful drainage', async () => {
  const shutdown = new WorkerShutdown('test', { diagnose: () => { throw new Error('logging'); } });
  shutdown.start(async () => {}); await shutdown.drain(); shutdown.complete();
});

test('unexpected live loop failure requests restart once instead of leaving a dead worker running', async () => {
  const exits: number[] = [];
  const shutdown = new WorkerShutdown('test', { diagnose: () => {}, forceExit: code => { exits.push(code); } });
  shutdown.start(async () => { throw new Error('unexpected loop failure'); });
  await Promise.resolve(); await Promise.resolve(); expect(exits).toEqual([1]);
  await expect(shutdown.drain()).rejects.toThrow('Worker drain failed'); expect(exits).toEqual([1]);
});

test('deadline remains active after operations drain until resource closure completes', async () => {
  const exits: number[] = []; const phases: ShutdownDiagnostic[] = [];
  const shutdown = new WorkerShutdown('test', { timeoutMs: 5, forceExit: code => { exits.push(code); }, diagnose: e => phases.push(e) });
  shutdown.start(async () => {}); await shutdown.drain();
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(exits).toEqual([1]); expect(phases.map(e => e.phase)).toEqual(['drain-started','drained','timeout']);
  expect(() => shutdown.complete()).toThrow();
});
test('successful resource closure cancels deadline and is idempotent', async () => {
  const exits: number[] = [];
  const shutdown = new WorkerShutdown('test', { timeoutMs: 5, forceExit: code => { exits.push(code); }, diagnose: () => {} });
  shutdown.start(async () => {}); await shutdown.drain(); shutdown.complete(); shutdown.complete();
  await new Promise(resolve => setTimeout(resolve, 15)); expect(exits).toEqual([]);
});

test('signal coordinator stops work before framework cleanup and completes after all resource hooks', async () => {
  const { closeWorkerApplication } = await import('../../src/shared/application/worker-signals');
  const phases: string[] = [];
  await closeWorkerApplication({ close: async signal => { expect(signal).toBe('SIGTERM'); phases.push('pool-and-resources-close'); } },
    { beforeApplicationShutdown: async () => { phases.push('drain'); }, completeShutdown: () => { phases.push('stopped'); } }, 'SIGTERM');
  expect(phases).toEqual(['drain','pool-and-resources-close','stopped']);
});
test('resource close failure does not report stopped or clear the safety deadline', async () => {
  const { closeWorkerApplication } = await import('../../src/shared/application/worker-signals'); let completed = false;
  await expect(closeWorkerApplication({ close: async () => { throw new Error('resource close failed'); } },
    { beforeApplicationShutdown: async () => {}, completeShutdown: () => { completed = true; } })).rejects.toThrow('resource close failed');
  expect(completed).toBe(false);
});
