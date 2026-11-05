export interface ShutdownDiagnostic { readonly component: string; readonly phase: 'drain-started' | 'drained' | 'stopped' | 'timeout' | 'drain-failed' | 'loop-failed' }
export interface ShutdownOptions {
  readonly timeoutMs?: number;
  /** Test seam. Production terminates instead of closing a pool while work is still alive. */
  readonly forceExit?: (code: number) => void;
  readonly diagnose?: (event: ShutdownDiagnostic) => void;
}
export function shutdownTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env['WORKER_SHUTDOWN_TIMEOUT_MS'] ?? '60000';
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 300000) throw new Error('Invalid WORKER_SHUTDOWN_TIMEOUT_MS');
  return Number(raw);
}
export class WorkerShutdownTimeoutError extends Error { override name = 'WorkerShutdownTimeoutError'; }
/** Drain precedes MikroORM close; the deadline stays active through the subsequent resource-close phase. */
export class WorkerShutdown {
  private readonly stop = new AbortController(); private task?: Promise<void>; private draining?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>; private exitRequested = false; private drained = false; private finished = false;
  private readonly timeoutMs: number; private readonly forceExit: (code: number) => void;
  private readonly diagnose: (event: ShutdownDiagnostic) => void;
  constructor(private readonly component: string, options: ShutdownOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? shutdownTimeoutMs();
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000) throw new Error('Invalid worker shutdown timeout');
    this.forceExit = options.forceExit ?? (code => { process.exit(code); });
    this.diagnose = options.diagnose ?? (event => console.log(JSON.stringify(event)));
  }
  start(work: (signal: AbortSignal) => Promise<void>): void {
    if (this.task || this.stop.signal.aborted) throw new Error('Worker cannot start twice or after shutdown');
    this.task = work(this.stop.signal);
    void this.task.catch(() => { this.emit('loop-failed'); if (!this.stop.signal.aborted) this.terminate(); });
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.stop.abort(); // Cancels polls; in-flight work keeps independent request/transaction lifetimes.
    this.emit('drain-started'); this.draining = this.wait(); return this.draining;
  }
  /** Called by the signal coordinator after app.close has completed all resource hooks. */
  complete(): void {
    if (!this.drained || this.exitRequested) throw new Error('Worker resources cannot finish before successful drainage');
    if (this.finished) return;
    this.finished = true; clearTimeout(this.timer); this.emit('stopped');
  }
  private async wait(): Promise<void> {
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        this.timer = setTimeout(() => {
          this.emit('timeout'); this.terminate(); reject(new WorkerShutdownTimeoutError('Worker shutdown deadline exceeded'));
        }, this.timeoutMs);
      });
      await Promise.race([this.task ?? Promise.resolve(), deadline]);
      this.drained = true; this.emit('drained'); // Keep deadline armed while the framework closes resources.
    } catch (error) {
      clearTimeout(this.timer);
      if (!(error instanceof WorkerShutdownTimeoutError)) this.emit('drain-failed');
      // No ACK is manufactured. OS disconnection + SQS visibility/Inbox and persisted leases recover uncertainty.
      this.terminate();
      throw error instanceof WorkerShutdownTimeoutError ? error : new Error('Worker drain failed');
    }
  }
  private terminate(): void { if (!this.exitRequested) { this.exitRequested = true; this.forceExit(1); } }
  private emit(phase: ShutdownDiagnostic['phase']): void {
    try { this.diagnose({ component: this.component, phase }); } catch { /* diagnostic only */ }
  }
}
