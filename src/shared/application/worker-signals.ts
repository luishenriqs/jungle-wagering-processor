export interface WorkerShutdownControl {
  beforeApplicationShutdown(): Promise<void>;
  completeShutdown(): void;
}
export interface WorkerApplication { close(signal?: string): Promise<void> }
/** Drain before framework destruction; acknowledge full shutdown only after every resource hook returns. */
export async function closeWorkerApplication(app: WorkerApplication, lifecycle: WorkerShutdownControl, signal?: string): Promise<void> {
  await lifecycle.beforeApplicationShutdown();
  await app.close(signal); // Repeated before hook is idempotent. MikroORM and SQS close with no active operations.
  lifecycle.completeShutdown(); // Disarm the watchdog only after the actual ORM pool has closed.
}
/** Standalone workers use this instead of Nest's automatic signal handler, whose root hook can precede ORM close. */
export function enableWorkerSignals(app: WorkerApplication, lifecycle: WorkerShutdownControl): void {
  let closing = false;
  const handler = (signal: string) => {
    if (closing) return;
    closing = true;
    void closeWorkerApplication(app, lifecycle, signal).then(() => {
      process.exit(0);
    }, () => {
      console.error(JSON.stringify({ component: 'worker-shutdown', phase: 'failed' }));
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => handler('SIGTERM')); process.on('SIGINT', () => handler('SIGINT'));
}
