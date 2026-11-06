import { expect, spyOn, test } from 'bun:test';
import { DefaultOperationalMetricsCollector } from '../../src/shared/application/operational-metrics';
import { WorkerMetricsReporter, workerMetricsIntervalMs } from '../../src/shared/infrastructure/worker-metrics-reporter';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
test('D04-FIX-T05 envelope has a unique execution identity and the full closed snapshot', () => {
  const collector = new DefaultOperationalMetricsCollector(); const lines: string[] = [];
  const reporter = new WorkerMetricsReporter(collector, 'sqs-consumer', { write: line => { lines.push(line); } });
  const second: string[] = [];
  const other = new WorkerMetricsReporter(collector, 'sqs-consumer', { write: line => { second.push(line); } });
  try {
    reporter.start(); other.start();
    expect(lines).toHaveLength(1); const frame = JSON.parse(lines[0]!);
    expect(frame).toEqual({ type: 'OperationalMetricsSnapshot', version: 1, component: 'sqs-consumer',
      executionId: expect.stringMatching(/^[a-f0-9-]{36}$/), pid: process.pid,
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), snapshot: collector.snapshot() });
    expect(frame.executionId).not.toBe(JSON.parse(second[0]!).executionId);
    expect(lines[0]!.split('\n')).toHaveLength(2);
  } finally { reporter.stop(); other.stop(); }
});
test('D04-FIX-T10 unchanged snapshots are skipped; changes remain cumulative and previous frames immutable', () => {
  const collector = new DefaultOperationalMetricsCollector(); const lines: string[] = [];
  const reporter = new WorkerMetricsReporter(collector, 'outbox-publisher', { write: line => { lines.push(line); } });
  reporter.start(); reporter.flush(); reporter.flush(); expect(lines).toHaveLength(1);
  collector.observe({ type: 'retry-scheduled', target: 'outboxPublisher' }); reporter.flush();
  expect(lines).toHaveLength(2); expect(JSON.parse(lines[1]!).snapshot.retries.outboxPublisher).toBe(1);
  expect(JSON.parse(lines[0]!).snapshot.retries.outboxPublisher).toBe(0);
  reporter.stop(); reporter.flush(); expect(lines).toHaveLength(2);
});
for (const mode of ['throw', 'reject', 'never'] as const) test(`D04-FIX-T07/T08/T09/T12 ${mode} stays fail-open and shutdown returns`, async () => {
  let writes = 0; const unhandled: unknown[] = []; const listener = (e: unknown) => { unhandled.push(e); };
  const collector = new DefaultOperationalMetricsCollector();
  const reporter = new WorkerMetricsReporter(collector, 'sqs-consumer', { write: () => {
    writes++; if (mode === 'throw') throw new Error('controlled writer failure');
    if (mode === 'reject') return Promise.reject(new Error('controlled async failure'));
    return new Promise(() => {});
  } });
  process.on('unhandledRejection', listener);
  try {
    reporter.start(); collector.observe({ type: 'wager-status', status: 'PROCESSED' });
    await turn(); reporter.flush(); await turn(); reporter.stop(); await turn();
    expect(collector.snapshot().transactionsByStatus.PROCESSED).toBe(1);
    expect(unhandled).toEqual([]); expect(writes).toBe(mode === 'never' ? 1 : 3);
  } finally { reporter.stop(); process.off('unhandledRejection', listener); }
});
test('D04-FIX-T10 one pending receipt prevents further snapshots, writes and queued samples', async () => {
  let snapshots = 0; let writes = 0; let complete!: () => void;
  const collector = new DefaultOperationalMetricsCollector();
  const reporter = new WorkerMetricsReporter({ observe: e => collector.observe(e), snapshot: () => { snapshots++; return collector.snapshot(); } },
    'pending-reference-worker', { write: () => { writes++; return new Promise<void>(resolve => { complete = resolve; }); } });
  reporter.start();
  for (let i = 0; i < 50000; i++) { collector.observe({ type: 'pending-reference-resolution', action: 'rescheduled' }); reporter.flush(); }
  expect(snapshots).toBe(1); expect(writes).toBe(1);
  complete(); await turn(); reporter.flush(); expect(writes).toBe(2); expect(snapshots).toBe(2);
  reporter.stop(); expect(writes).toBe(2); complete(); await turn();
});
test('D04-FIX-T11 closed projection rejects secrets, accessors and malformed snapshots without serializing them', () => {
  let getterReads = 0; const lines: string[] = []; const collector = new DefaultOperationalMetricsCollector();
  for (const snapshot of [
    { ...collector.snapshot(), authorization: 'Bearer SYNTHETIC_SECRET' },
    { ...collector.snapshot(), retries: { ...collector.snapshot().retries, sqsConsumer: Number.NaN } },
    Object.defineProperty({}, 'scope', { enumerable: true, get() { getterReads++; throw new Error('SYNTHETIC_SECRET'); } }),
    { ...collector.snapshot(), duplicates: { replays: 1, conflicts: 0, toJSON: () => 'SYNTHETIC_SECRET' } },
  ]) {
    const reporter = new WorkerMetricsReporter({ observe() {}, snapshot: () => snapshot as never }, 'sqs-consumer', { write: line => { lines.push(line); } });
    reporter.start(); reporter.stop();
  }
  expect(lines).toEqual([]); expect(getterReads).toBe(0);
});
test('D04-FIX serialization and snapshot failures stay isolated and later samples recover', () => {
  const collector = new DefaultOperationalMetricsCollector(); const lines: string[] = []; let broken = true;
  const reporter = new WorkerMetricsReporter({ observe() {}, snapshot() { if (broken) throw new Error('snapshot failure'); return collector.snapshot(); } },
    'sqs-consumer', { write: line => { lines.push(line); } });
  reporter.start(); expect(lines).toEqual([]); broken = false; reporter.flush(); reporter.stop(); expect(lines).toHaveLength(1);
});
test('D04-FIX-T12 periodic timer is cancelled and final changed sample is best effort', async () => {
  const collector = new DefaultOperationalMetricsCollector(); const lines: string[] = [];
  const reporter = new WorkerMetricsReporter(collector, 'outbox-publisher', { intervalMs: 50, write: line => { lines.push(line); } });
  reporter.start(); collector.observe({ type: 'outbox-publication-confirmed', lagMs: 3 });
  await Bun.sleep(80); expect(lines).toHaveLength(2);
  collector.observe({ type: 'outbox-publication-confirmed', lagMs: 4 }); reporter.stop(); expect(lines).toHaveLength(3);
  collector.observe({ type: 'outbox-publication-confirmed', lagMs: 5 }); await Bun.sleep(80); expect(lines).toHaveLength(3);
});
test('D04-FIX interval configuration is bounded and has a 10 second default', () => {
  expect(workerMetricsIntervalMs({})).toBe(10000); expect(workerMetricsIntervalMs({ WORKER_METRICS_INTERVAL_MS: '50' })).toBe(50);
  for (const value of ['0', '49', '-1', '1.5', '1e3', 'NaN', '', ' 1000', '3600001']) {
    expect(() => workerMetricsIntervalMs({ WORKER_METRICS_INTERVAL_MS: value })).toThrow();
  }
});
test('D04-FIX serialization exceptions are contained and recover without dropping cumulative counts', () => {
  const collector = new DefaultOperationalMetricsCollector(); const lines: string[] = [];
  const reporter = new WorkerMetricsReporter(collector, 'sqs-consumer', { write: line => { lines.push(line); } });
  const stringify = spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('Controlled serialization fault'); });
  try { reporter.start(); reporter.flush(); } finally { stringify.mockRestore(); }
  expect(lines).toEqual([]); collector.observe({ type: 'duplicate', kind: 'replay' }); reporter.flush(); reporter.stop();
  expect(JSON.parse(lines[0]!).snapshot.duplicates.replays).toBe(1);
});
test('D04-FIX synchronous writer reentry is fenced and hostile Promise.then is not read', async () => {
  const collector = new DefaultOperationalMetricsCollector(); let writes = 0; let reads = 0;
  const reporter = new WorkerMetricsReporter(collector, 'outbox-publisher', { write: () => {
    writes++; reporter.flush();
    const receipt = Promise.reject(new Error('Controlled rejection'));
    Object.defineProperty(receipt, 'then', { get() { reads++; throw new Error('Hostile getter'); } }); return receipt;
  } });
  reporter.start(); expect(writes).toBe(1); await turn(); reporter.stop(); await turn(); expect(reads).toBe(0); expect(writes).toBe(2);
});
