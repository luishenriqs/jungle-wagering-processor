import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { PendingReferenceWorker } from '../application/pending-reference-worker';
import { WorkerShutdown, type ShutdownOptions } from '../../../shared/application/worker-shutdown';

export class PendingReferenceLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly shutdown: WorkerShutdown;
  constructor(private readonly worker: Pick<PendingReferenceWorker, 'run'>, private readonly pollMs: number,
    private readonly batchSize: number, options: ShutdownOptions = {}) { this.shutdown = new WorkerShutdown('pending-reference-worker', options); }
  onApplicationBootstrap(): void { this.shutdown.start(signal => this.worker.run(signal, this.pollMs, this.batchSize)); }
  beforeApplicationShutdown(): Promise<void> { return this.shutdown.drain(); }
  completeShutdown(): void { this.shutdown.complete(); }
}
