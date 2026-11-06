import { randomUUID } from 'node:crypto';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWork } from '../../shared/application/financial-store';
import { workerConfig, type WorkerConfig } from './application/worker-config';
import { OutboxPublisher } from './application/outbox-publisher';
import { AwsSqsOutboxTransport } from './infrastructure/aws-sqs-outbox-transport';
import { PublisherLifecycle } from './infrastructure/publisher-lifecycle';
import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction.use-case';
import { CLOCK, SystemClock, type ClockPort } from '../../shared/application/clock';
import { consumerConfig, type ConsumerConfig } from './application/consumer-config';
import { SqsWagerConsumer } from './application/sqs-wager-consumer';
import { localSqsClient } from './infrastructure/local-sqs-client';
import { AwsSqsConsumerTransport } from './infrastructure/aws-sqs-consumer-transport';
import { ConsumerLifecycle } from './infrastructure/consumer-lifecycle';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { stderrOperationalLog } from '../../shared/infrastructure/structured-logger';
import { OPERATIONAL_METRICS, type OperationalMetricsCollector } from '../../shared/application/operational-metrics';
import { WorkerMetricsReporter } from '../../shared/infrastructure/worker-metrics-reporter';

interface StandaloneMetricsOptions { readonly metrics?: OperationalMetricsCollector | undefined }

const SQS_CLIENT = Symbol('SQS_CLIENT'); const CONFIG = Symbol('SQS_CONSUMER_CONFIG');
@Module({})
export class MessagingModule {
  /** Explicit standalone consumer composition; importing the base module starts no workers. */
  static forConsumer(options: StandaloneMetricsOptions = {}): DynamicModule {
    return { module: MessagingModule, imports: [DatabaseModule.forRoot({ metrics: options.metrics })], providers: [
      { provide: CLOCK, useFactory: () => new SystemClock() },
      { provide: CONFIG, useFactory: () => consumerConfig() },
      { provide: SQS_CLIENT, useFactory: () => localSqsClient() },
      { provide: AwsSqsConsumerTransport, inject: [SQS_CLIENT, CONFIG],
        useFactory: async (client: SQSClient, config: ConsumerConfig) => {
          try { return await AwsSqsConsumerTransport.connect(client, config, process.env['SQS_INPUT_QUEUE_NAME'], process.env['SQS_DLQ_QUEUE_NAME']); }
          catch (error) { client.destroy(); throw error; }
        } },
      { provide: SqsWagerConsumer, inject: [ProcessWagerTransactionUseCase, AwsSqsConsumerTransport, CLOCK, CONFIG, OPERATIONAL_METRICS],
        useFactory: (processor: ProcessWagerTransactionUseCase, transport: AwsSqsConsumerTransport, clock: ClockPort, config: ConsumerConfig, metrics: OperationalMetricsCollector) =>
          new SqsWagerConsumer(processor, transport, clock, config, undefined, { operationalLog: stderrOperationalLog, operationalMetrics: metrics }) },
      { provide: ConsumerLifecycle, inject: [SqsWagerConsumer, SQS_CLIENT],
        useFactory: (consumer: SqsWagerConsumer, client: SQSClient) => new ConsumerLifecycle(consumer, client) },
      { provide: WorkerMetricsReporter, inject: [OPERATIONAL_METRICS],
        useFactory: (metrics: OperationalMetricsCollector) => new WorkerMetricsReporter(metrics, 'sqs-consumer') },
    ], exports: [SqsWagerConsumer] };
  }
  /** Publisher is independently deployable; the consumer and HTTP modules remain unchanged. */
  static forPublisher(options: StandaloneMetricsOptions = {}): DynamicModule {
    const POLL = Symbol('OUTBOX_POLL');
    return { module: MessagingModule, imports: [DatabaseModule.forRoot({ metrics: options.metrics })], providers: [
      { provide: CLOCK, useFactory: () => new SystemClock() },
      { provide: CONFIG, useFactory: () => workerConfig() },
      { provide: POLL, useFactory: () => {
        const raw = process.env['OUTBOX_POLL_INTERVAL_MS'] ?? '250';
        if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 60000) throw new Error('Invalid OUTBOX_POLL_INTERVAL_MS');
        return Number(raw);
      } },
      { provide: SQS_CLIENT, useFactory: () => localSqsClient() },
      { provide: AwsSqsOutboxTransport, inject: [SQS_CLIENT, CONFIG],
        useFactory: async (client: SQSClient, config: WorkerConfig) => {
          try { return await AwsSqsOutboxTransport.connect(client, config.sqsSendTimeoutMs, process.env['SQS_EVENTS_QUEUE_NAME']); }
          catch (error) { client.destroy(); throw error; }
        } },
      { provide: OutboxPublisher, inject: [FINANCIAL_UNIT_OF_WORK, AwsSqsOutboxTransport, CLOCK, CONFIG, OPERATIONAL_METRICS],
        useFactory: (uow: FinancialUnitOfWork, transport: AwsSqsOutboxTransport, clock: ClockPort, config: WorkerConfig, metrics: OperationalMetricsCollector) =>
          new OutboxPublisher(uow, transport, clock, config, { workerId: process.env['OUTBOX_WORKER_ID'] ?? `outbox-${process.pid}-${randomUUID()}`, operationalLog: stderrOperationalLog, operationalMetrics: metrics }) },
      { provide: PublisherLifecycle, inject: [OutboxPublisher, SQS_CLIENT, POLL],
        useFactory: (publisher: OutboxPublisher, client: SQSClient, pollMs: number) => new PublisherLifecycle(publisher, client, pollMs) },
      { provide: WorkerMetricsReporter, inject: [OPERATIONAL_METRICS],
        useFactory: (metrics: OperationalMetricsCollector) => new WorkerMetricsReporter(metrics, 'outbox-publisher') },
    ], exports: [OutboxPublisher] };
  }

}
