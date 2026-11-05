import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Harness } from './postgres';
import type { PendingCandidate, PendingResolution } from '../../src/modules/wagering/application/pending-reference-worker';
import type { PendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';

export interface PendingChildRecord { readonly type: string; readonly pid?: number; readonly backendPid?: number; readonly results?: PendingResolution[] }
export async function pendingWorkerChild(h: Harness, at: Date, policy: PendingReferencePolicy, candidate?: PendingCandidate) {
  const child = spawn(process.execPath, ['test/support/pending-worker-child.ts'], { cwd: process.cwd(), env: { ...process.env,
    TEST_DATABASE_URL: h.url, JUNGLE_TEST_SCHEMA: h.schema, JUNGLE_TEST_PENDING_NOW: at.toISOString(),
    JUNGLE_TEST_PENDING_CANDIDATE: candidate ? JSON.stringify(candidate) : '',
    PENDING_REF_BASE_DELAY_MS: String(policy.baseDelayMs), PENDING_REF_MAX_ATTEMPTS: String(policy.maxAttempts), PENDING_REF_TTL_MS: String(policy.ttlMs),
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  let readyResolve!: (record: PendingChildRecord) => void; let readyReject!: (error: Error) => void;
  const ready = new Promise<PendingChildRecord>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const records: PendingChildRecord[] = [];
  const timer = setTimeout(() => { readyReject(new Error('Pending worker child timeout')); child.kill('SIGKILL'); }, 60000);
  const lines = createInterface({ input: child.stdout }); child.stderr.on('data', () => {});
  lines.on('line', line => {
    let record: PendingChildRecord;
    try { record = JSON.parse(line) as PendingChildRecord; } catch { return; }
    records.push(record); if (record.type === 'ready') readyResolve(record);
  });
  child.once('error', () => readyReject(new Error('Cannot start pending worker child')));
  const done = new Promise<number | null>(resolve => child.once('close', code => {
    clearTimeout(timer); lines.close(); readyReject(new Error(`Pending worker exited before readiness: ${code}`)); resolve(code);
  }));
  try {
    const identity = await ready;
    return { ...identity, records, start: () => { child.stdin.write('go\n'); }, done,
      async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; } };
  } catch (error) { child.kill('SIGKILL'); await done; throw error; }
}
