import { enableWorkerSignals, type WorkerShutdownControl } from '../../src/shared/application/worker-signals';
import 'reflect-metadata';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/database/config';
import { PostgresUnitOfWork } from '../../src/database/postgres-unit-of-work';
import type { FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import type { ShutdownOptions } from '../../src/shared/application/worker-shutdown';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { pendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { PendingReferenceLifecycle } from '../../src/modules/wagering/infrastructure/pending-reference-lifecycle';
import { SqsWagerConsumer } from '../../src/modules/messaging/application/sqs-wager-consumer';
import type { SqsConsumerTransport } from '../../src/modules/messaging/application/sqs-transport';
import { consumerConfig } from '../../src/modules/messaging/application/consumer-config';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
import { OutboxPublisher, type OutboxTransport } from '../../src/modules/messaging/application/outbox-publisher';
import { localSqsClient } from '../../src/modules/messaging/infrastructure/local-sqs-client';
import { AwsSqsConsumerTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-consumer-transport';
import { AwsSqsOutboxTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-outbox-transport';
import { ConsumerLifecycle } from '../../src/modules/messaging/infrastructure/consumer-lifecycle';
import { PublisherLifecycle } from '../../src/modules/messaging/infrastructure/publisher-lifecycle';
import { testDatabaseUrl } from './postgres';

const schema = process.env['JUNGLE_TEST_SCHEMA'] ?? ''; const mode = process.env['JUNGLE_TEST_RESILIENCE_MODE'] ?? '';
const inputName = process.env['JUNGLE_TEST_INPUT_QUEUE'] ?? ''; const dlqName = process.env['JUNGLE_TEST_DLQ_QUEUE'] ?? '';
const eventsName = process.env['JUNGLE_TEST_EVENTS_QUEUE'] ?? ''; const at = new Date(process.env['JUNGLE_TEST_RESILIENCE_NOW'] ?? '');
const modes = ['consumer-normal','consumer-idle','consumer-before-commit','consumer-after-commit','consumer-received','consumer-timeout',
  'consumer-crash-before-commit','consumer-failure-on-stop','publisher-normal','publisher-after-claim','publisher-after-send','pending-normal','pending-before-commit'];
if (!/^jungle_it_[a-f0-9]{32}$/.test(schema) || !modes.includes(mode) || !Number.isFinite(at.getTime())
  || ![inputName,dlqName,eventsName].every(n => /^jungle_it_[a-f0-9]{32}_(input|dlq|events)\.fifo$/.test(n))) throw new Error('Invalid isolated resilience configuration');
function emit(phase: string, data: Record<string, unknown> = {}) { writeSync(1, JSON.stringify({ type: 'phase', phase, pid: process.pid, ...data }) + '\n'); }
let start!: () => void; let release!: () => void;
const go = new Promise<void>(resolve => { start = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { if (line === 'go') start(); if (line === 'release') release(); });
async function started(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
    signal.addEventListener('abort', finish, { once: true }); void go.then(finish); if (signal.aborted) finish();
  });
}
let activeProcessor = false; let ackInFlight = false; let backendPid: number | undefined;
const clock = { now: () => new Date(at) };
const options: ShutdownOptions = { diagnose: e => emit(e.phase) };
@Module({}) class ResilienceContext {}
const runtime = Symbol('RESILIENCE_RUNTIME');
try {
  const app = await NestFactory.createApplicationContext({ module: ResilienceContext,
    imports: [MikroOrmModule.forRoot({ ...databaseConfig(testDatabaseUrl(), schema), registerRequestContext: false, pool: { min: 0, max: 2 } })],
    providers: [{ provide: runtime, inject: [CoreORM], useFactory: async (orm: MikroORM) => {
      const actualClose = orm.close.bind(orm);
      orm.close = async (force?: boolean) => {
        emit('pool-close-started', { activeProcessor, ackInFlight }); await actualClose(force);
        emit('pool-closed', { connected: await orm.isConnected() });
      };
      const [identity] = await orm.em.fork().execute<{ backend_pid: number }[]>('select pg_backend_pid() as backend_pid'); backendPid = identity?.backend_pid;
      const uow = new PostgresUnitOfWork(orm);
      if (mode.startsWith('pending-')) {
        const worker = new PendingReferenceWorker(uow, clock, pendingReferencePolicy({}), { diagnose: () => {}, checkpoint: async phase => {
          if (mode === 'pending-before-commit' && phase === 'beforeCommit') { emit('pending-before-commit'); await gate; }
        } });
        const original = worker.resolve.bind(worker);
        worker.resolve = async candidate => { activeProcessor = true;
          try { const result = await original(candidate); emit('pending-resolved', { action: result.action, transactionId: result.transactionId }); return result; }
          finally { activeProcessor = false; }
        };
        return new PendingReferenceLifecycle({ run: async signal => { await started(signal); await worker.run(signal, 20, 100); } }, 20, 100, options);
      }
      const client = localSqsClient(); const actualDestroy = client.destroy.bind(client);
      client.destroy = () => { emit('sqs-close'); actualDestroy(); };
      if (mode.startsWith('publisher-')) {
        const transport = await AwsSqsOutboxTransport.connect(client, 3000, eventsName);
        const wrappedUow: FinancialUnitOfWork = { run: async (work, isolation) => {
          const result = await uow.run(work, isolation);
          if (mode === 'publisher-after-claim' && result && typeof result === 'object' && 'message' in result) {
            if (!(result.message instanceof OutboxMessage)) throw new Error('Expected a committed Outbox claim');
            emit('claim-committed', { eventId: result.message.id }); await gate;
          }
          return result;
        } };
        const sender: OutboxTransport = { publish: async (m, signal) => {
          await transport.publish(m, signal); emit('send-confirmed', { eventId: m.id });
          if (mode === 'publisher-after-send') await gate;
        } };
        const publisher = new OutboxPublisher(wrappedUow, sender, clock, workerConfig({}), { workerId: `resilience-${process.pid}`,
          diagnose: e => { if (e.action === 'published') emit('published', { eventId: e.eventId }); } });
        return new PublisherLifecycle({ run: async signal => { await started(signal); await publisher.run(signal, 20); } }, client, 20, options);
      }
      const crash = ['consumer-after-commit','consumer-crash-before-commit','consumer-timeout'].includes(mode);
      // Aborting HTTP cannot revoke a server-side receive with an unknown receipt. Keep
      // its visibility below the recovery phase budget, without shortening long polling.
      const config = consumerConfig({ SQS_MAX_RECEIVE_COUNT: '3', SQS_WAIT_SECONDS: '20', SQS_VISIBILITY_TIMEOUT_SECONDS: crash || mode === 'consumer-idle' ? '1' : '30' });
      const transport = await AwsSqsConsumerTransport.connect(client, config, inputName, dlqName);
      const processCase = new ProcessWagerTransactionUseCase(uow, { now: () => clock.now(), pendingReferencePolicy: pendingReferencePolicy({}), checkpoint: async phase => {
        if (['consumer-before-commit','consumer-crash-before-commit','consumer-timeout','consumer-failure-on-stop'].includes(mode) && phase === 'beforeCommit') { emit('before-commit'); await gate;
          if (mode === 'consumer-failure-on-stop') throw Object.assign(new Error('injected settled rollback'), { code: 'ECONNRESET' }); }
      } });
      let pollId = 0;
      const wrapped: SqsConsumerTransport = {
        receive: async signal => {
          const id = ++pollId;
          emit('poll-started', { pollId: id });
          const aborted = () => emit('poll-abort-observed', { pollId: id });
          signal?.addEventListener('abort', aborted, { once: true });
          try {
            const message = await transport.receive(signal);
            emit('poll-returned', { pollId: id, received: !!message, ...(message ? { receiveCount: message.receiveCount } : {}) });
            if (message && mode === 'consumer-received') { emit('received-unprocessed'); await gate; }
            return message;
          } catch (error) {
            emit(signal?.aborted ? 'poll-cancelled' : 'poll-failed', { pollId: id });
            throw error;
          } finally { signal?.removeEventListener('abort', aborted); }
        },
        retry: async (receipt, delay) => { await transport.retry(receipt, delay); if (delay === 0) emit('visibility-released'); },
        deadLetter: (body, group, dedup) => transport.deadLetter(body, group, dedup),
        acknowledge: async receipt => { ackInFlight = true;
          try { const [row] = await orm.em.fork().execute<{ n: number }[]>('select 1 as n');
            await transport.acknowledge(receipt); emit('acked', { poolOpen: row?.n === 1 }); }
          finally { ackInFlight = false; }
        },
      };
      const consumer = new SqsWagerConsumer({ execute: async input => {
        activeProcessor = true;
        try { const result = await processCase.execute(input); emit('committed', { replay: result.idempotentReplay, transactionId: result.transactionId, status: result.status });
          if (mode === 'consumer-after-commit') { emit('after-commit-before-ack'); await gate; } return result;
        } finally { activeProcessor = false; }
      } }, wrapped, clock, config, () => {});
      return new ConsumerLifecycle({ run: async signal => { await started(signal); await consumer.run(signal); } }, client, options);
    } }],
  }, { logger: false, abortOnError: false });
  enableWorkerSignals(app, app.get<WorkerShutdownControl>(runtime));
  writeSync(1, JSON.stringify({ type: 'ready', pid: process.pid, backendPid }) + '\n');
} catch {
  emit('startup-failed'); process.exit(1);
}
