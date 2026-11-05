import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Harness } from './postgres';
import type { SqsHarness } from './sqs';
import type { OutboxSqsHarness } from './outbox-sqs';
export type ResilienceMode = 'consumer-normal' | 'consumer-idle' | 'consumer-before-commit' | 'consumer-after-commit' | 'consumer-received' | 'consumer-timeout'
  | 'consumer-failure-on-stop' | 'consumer-crash-before-commit' | 'publisher-normal' | 'publisher-after-claim' | 'publisher-after-send' | 'pending-normal' | 'pending-before-commit';
export interface ResilienceRecord { readonly type: string; readonly phase?: string; readonly pid?: number; readonly backendPid?: number;
  readonly replay?: boolean; readonly poolOpen?: boolean; readonly connected?: boolean; readonly activeProcessor?: boolean;
  readonly ackInFlight?: boolean; readonly eventId?: string; readonly action?: string; readonly transactionId?: string;
  readonly pollId?: number; readonly received?: boolean; readonly receiveCount?: number }
export function phaseFailure(reason: string, expected: string, mode: ResilienceMode, pid: number | undefined, records: readonly ResilienceRecord[]): Error {
  // Only phase names from the test protocol; never dump payloads, receipts, environment or raw errors.
  const phases = records.slice(-16).map(r => r.phase ?? r.type).join(' -> ');
  return new Error(`${reason}; expected=${expected}; mode=${mode}; pid=${pid ?? 'unknown'}; phases=[${phases}]`);
}
export async function resilienceClient(pg: Harness, sqs: SqsHarness, events: OutboxSqsHarness, mode: ResilienceMode, now: Date, shutdownMs = 5000) {
  const child = spawn(process.execPath, ['test/support/resilience-child.ts'], { cwd: process.cwd(), env: { ...process.env,
    TEST_DATABASE_URL: pg.url, JUNGLE_TEST_SCHEMA: pg.schema, JUNGLE_TEST_INPUT_QUEUE: sqs.inputName, JUNGLE_TEST_DLQ_QUEUE: sqs.dlqName,
    JUNGLE_TEST_EVENTS_QUEUE: events.name, JUNGLE_TEST_RESILIENCE_MODE: mode, JUNGLE_TEST_RESILIENCE_NOW: now.toISOString(),
    WORKER_SHUTDOWN_TIMEOUT_MS: String(shutdownMs),
  }, stdio: ['pipe','pipe','pipe'] });
  const records: ResilienceRecord[] = [];
  const listeners = new Set<() => void>(); let ended = false;
  const lines = createInterface({ input: child.stdout }); child.stderr.on('data', () => {});
  lines.on('line', line => { try { const r: unknown = JSON.parse(line); if (r && typeof r === 'object') records.push(r as ResilienceRecord); } catch { return; }
    for (const notify of listeners) notify(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => {
    ended = true; lines.close(); for (const notify of listeners) notify(); resolve({ code, signal });
  }));
  child.once('error', () => { ended = true; for (const notify of listeners) notify(); });
  const waitFor = (test: (r: ResilienceRecord) => boolean, timeoutMs = 15000, expected = 'predicate'): Promise<ResilienceRecord> => new Promise((resolve, reject) => {
    const check = () => {
      const r = records.find(test);
      if (r) { clearTimeout(timer); listeners.delete(check); resolve(r); }
      else if (ended) { clearTimeout(timer); listeners.delete(check); reject(phaseFailure('Worker exited before expected phase', expected, mode, child.pid, records)); }
    };
    const timer = setTimeout(() => { listeners.delete(check); reject(phaseFailure('Worker phase timeout', expected, mode, child.pid, records)); }, timeoutMs);
    listeners.add(check); check();
  });
  try {
    const identity = await waitFor(r => r.type === 'ready', 15000, 'ready');
    return { ...identity, records, done, waitFor,
      phase: (phase: string, timeoutMs?: number) => waitFor(r => r.phase === phase, timeoutMs, phase),
      start: () => { child.stdin.write('go\n'); }, release: () => { child.stdin.write('release\n'); },
      signal: (signal: 'SIGTERM' | 'SIGKILL') => { child.kill(signal); },
      async close() { if (!ended) child.kill('SIGKILL'); await done; },
    };
  } catch (error) { child.kill('SIGKILL'); await done; throw error; }
}
export type ResilienceClient = Awaited<ReturnType<typeof resilienceClient>>;
