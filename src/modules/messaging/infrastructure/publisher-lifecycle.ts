import type { BeforeApplicationShutdown, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxPublisher } from '../application/outbox-publisher';
import { WorkerShutdown, type ShutdownOptions } from '../../../shared/application/worker-shutdown';

export class PublisherLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly shutdown: WorkerShutdown;
  constructor(private readonly publisher: Pick<OutboxPublisher, 'run'>, private readonly client: Pick<SQSClient, 'destroy'>,
    private readonly pollMs: number, options: ShutdownOptions = {}) { this.shutdown = new WorkerShutdown('outbox-publisher', options); }
  onApplicationBootstrap(): void { this.shutdown.start(signal => this.publisher.run(signal, this.pollMs)); }
  beforeApplicationShutdown(): Promise<void> { return this.shutdown.drain(); }
  onApplicationShutdown(): void { this.client.destroy(); }
  completeShutdown(): void { this.shutdown.complete(); }
}
