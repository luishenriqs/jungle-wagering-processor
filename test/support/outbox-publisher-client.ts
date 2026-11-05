import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Harness } from './postgres';

export interface PublisherChildRecord { readonly type: string; readonly pid?: number; readonly backendPid?: number;
  readonly phase?: string; readonly eventId?: string; readonly published?: number }
export async function publisherChild(h: Harness, queue: string, now: Date,
  mode: 'publish-all' | 'crash-after-claim' | 'crash-after-publish' = 'publish-all') {
  const child = spawn(process.execPath, ['test/support/outbox-publisher-child.ts'], { cwd: process.cwd(),
    env: { ...process.env, TEST_DATABASE_URL: h.url, JUNGLE_TEST_SCHEMA: h.schema, JUNGLE_TEST_EVENTS_QUEUE: queue,
      JUNGLE_TEST_PUBLISHER_NOW: now.toISOString(), JUNGLE_TEST_PUBLISHER_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
  const records: PublisherChildRecord[] = [];
  let readyResolve!: (value: PublisherChildRecord) => void; let readyReject!: (error: Error) => void;
  const ready = new Promise<PublisherChildRecord>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => { readyReject(new Error('Publisher child timeout')); child.kill('SIGKILL'); }, 60000);
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => {}); // Never surface credential-bearing startup failures from a child environment.
  lines.on('line', line => {
    let record: PublisherChildRecord;
    try { record = JSON.parse(line) as PublisherChildRecord; } catch { return; }
    records.push(record); if (record.type === 'ready') readyResolve(record);
  });
  child.once('error', () => readyReject(new Error('Cannot start publisher child')));
  const done = new Promise<number | null>(resolve => child.once('close', code => {
    clearTimeout(timer); lines.close(); readyReject(new Error(`Publisher exited before readiness: ${code}`)); resolve(code);
  }));
  try {
    const identity = await ready;
    return { ...identity, records, start: () => { child.stdin.write('go\n'); }, done,
      async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; } };
  } catch (error) { child.kill('SIGKILL'); await done; throw error; }
}
