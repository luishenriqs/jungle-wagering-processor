import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { entrypointIsolation } from './entrypoint-isolation';

export const entrypoints = [
  ['scripts/consume-wagers.ts', 'sqs-consumer'],
  ['scripts/publish-outbox.ts', 'outbox-publisher'],
  ['scripts/resolve-pending-references.ts', 'pending-reference-worker'],
] as const;
export type Entrypoint = typeof entrypoints[number][0];
export interface EntrypointRecord { component?: string; phase?: string; action?: string; code?: string }
export function entrypointClient(script: Entrypoint, env: Record<string, string | undefined>) {
  entrypointIsolation(env); // Validate the exact environment passed to the child, before spawn.
  const child = spawn(process.execPath, ['--preload', './test/support/entrypoint-preload.ts', script],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const records: EntrypointRecord[] = []; let ended = false; let invalidOutput = false;
  const listeners = new Set<() => void>();
  const readers = [child.stdout, child.stderr].map(stream => {
    const reader = createInterface({ input: stream });
    reader.on('line', line => {
      try { records.push(JSON.parse(line) as EntrypointRecord); } catch { invalidOutput = true; }
      for (const listener of listeners) listener();
    });
    return reader;
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', () => { ended = true; for (const listener of listeners) listener(); reject(new Error('Entrypoint spawn failed')); });
    child.once('close', (code, signal) => { ended = true; readers.forEach(r => r.close());
      for (const listener of listeners) listener(); resolve({ code, signal }); });
  });
  // Observe rejection immediately, including when startup never emits a record.
  void done.catch(() => {});
  const waitFor = (predicate: (record: EntrypointRecord) => boolean, timeoutMs = 15000) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (records.some(predicate)) { clearTimeout(timer); listeners.delete(check); resolve(); }
      else if (ended) { clearTimeout(timer); listeners.delete(check); reject(new Error('Entrypoint exited before expected diagnostic')); }
    };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Entrypoint diagnostic timeout')); }, timeoutMs);
    listeners.add(check); check();
  });
  return { records, done, waitFor, get invalidOutput() { return invalidOutput; },
    signal() { child.kill('SIGTERM'); },
    async close() { if (!ended) child.kill('SIGKILL'); await done; },
  };
}
export type EntrypointClient = ReturnType<typeof entrypointClient>;
