import type { BeforeApplicationShutdown, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsWagerConsumer } from '../application/sqs-wager-consumer';
import { WorkerShutdown, type ShutdownOptions } from '../../../shared/application/worker-shutdown';

export class ConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly shutdown: WorkerShutdown;
  constructor(private readonly consumer: Pick<SqsWagerConsumer, 'run'>, private readonly client: Pick<SQSClient, 'destroy'>, options: ShutdownOptions = {}) {
    this.shutdown = new WorkerShutdown('sqs-consumer', options);
  }
  onApplicationBootstrap(): void { this.shutdown.start(signal => this.consumer.run(signal)); }
  beforeApplicationShutdown(): Promise<void> { return this.shutdown.drain(); }
  onApplicationShutdown(): void { this.client.destroy(); }
  completeShutdown(): void { this.shutdown.complete(); }
}
