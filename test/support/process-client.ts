import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ProcessWagerInput, ProcessWagerResult } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { Harness } from './postgres';

interface Outcome { type: 'result'; id: string; ok: boolean; result?: ProcessWagerResult; error?: string }
export async function processClient(h: Harness) {
  const child = spawn(process.execPath, ['test/support/process-worker.ts'], { cwd: process.cwd(),
    env: { ...process.env, TEST_DATABASE_URL: h.url, JUNGLE_TEST_SCHEMA: h.schema }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<string, { resolve: (outcome: Outcome) => void; reject: (error: Error) => void }>();
  let readyResolve!: (data: { pid: number; backendPid: number }) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<{ pid: number; backendPid: number }>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => { readyReject(new Error('Worker readiness timeout')); child.kill(); }, 15000);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message: Outcome | { type: 'ready'; pid: number; backendPid: number };
    try { message = JSON.parse(line) as typeof message; } catch { return; } // ORM startup logs are not protocol messages.
    if (message.type === 'ready') { clearTimeout(timer); readyResolve(message); }
    else { pending.get(message.id)?.resolve(message); pending.delete(message.id); }
  });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => {
    clearTimeout(timer); lines.close();
    const error = new Error(`Worker exited ${code}; ${stderr}`);
    readyReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); resolve(code);
  }));
  child.once('error', error => { clearTimeout(timer); readyReject(error); for (const waiter of pending.values()) waiter.reject(error); });
  const identity = await ready;
  return { ...identity,
    run(input: ProcessWagerInput, mode?: 'exit-before-commit' | 'exit-after-commit'): Promise<Outcome> {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Worker operation timeout')); child.kill(); }, 20000);
        pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
        child.stdin.write(`${JSON.stringify({ type: 'run', id, input, mode })}\n`);
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.write(`${JSON.stringify({ type: 'close' })}\n`);
      const timeout = setTimeout(() => child.kill(), 3000);
      try { await exited; } finally { clearTimeout(timeout); }
    },
  };
}
