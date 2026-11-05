import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/database/config';
import { PostgresUnitOfWork } from '../../src/database/postgres-unit-of-work';
import type { FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import type { OutboxClaim } from '../../src/shared/application/worker-store';
import { OutboxPublisher, type OutboxTransport } from '../../src/modules/messaging/application/outbox-publisher';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
import { localSqsClient } from '../../src/modules/messaging/infrastructure/local-sqs-client';
import { AwsSqsOutboxTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-outbox-transport';
import { testDatabaseUrl } from './postgres';

const schema = process.env['JUNGLE_TEST_SCHEMA'] ?? '';
const queue = process.env['JUNGLE_TEST_EVENTS_QUEUE'] ?? '';
const mode = process.env['JUNGLE_TEST_PUBLISHER_MODE'];
const now = new Date(process.env['JUNGLE_TEST_PUBLISHER_NOW'] ?? '');
if (!/^jungle_it_[a-f0-9]{32}$/.test(schema) || !/^jungle_it_[a-f0-9]{32}_events\.fifo$/.test(queue)
  || !['publish-all', 'crash-after-claim', 'crash-after-publish'].includes(mode ?? '') || !Number.isFinite(now.getTime())) throw new Error('Invalid isolated publisher test configuration');
const orm = await MikroORM.init({ ...databaseConfig(testDatabaseUrl(), schema), pool: { min: 0, max: 1 } });
const client = localSqsClient();
try {
  const transport = await AwsSqsOutboxTransport.connect(client, 3000, queue);
  const actual = new PostgresUnitOfWork(orm);
  const uow: FinancialUnitOfWork = { run: async (work, isolation) => {
    const result = await actual.run(work, isolation);
    if (mode === 'crash-after-claim') {
      const claim = result as OutboxClaim | undefined;
      if (!claim) throw new Error('Crash test requires a committed claim');
      writeSync(1, JSON.stringify({ type: 'phase', phase: 'claim-committed', eventId: claim.message.id, pid: process.pid }) + '\n');
      process.exit(71); // Deliberately no ORM/client shutdown: committed lease must survive process exit.
    }
    return result;
  } };
  const sender: OutboxTransport = { publish: async (message, signal) => {
    await transport.publish(message, signal);
    if (mode === 'crash-after-publish') {
      writeSync(1, JSON.stringify({ type: 'phase', phase: 'send-confirmed', eventId: message.id, pid: process.pid }) + '\n');
      process.exit(72); // Send accepted, but published_at was not updated.
    }
  } };
  const publisher = new OutboxPublisher(uow, sender, { now: () => new Date(now) }, workerConfig({}),
    { workerId: `child-${process.pid}`, diagnose: () => {} });
  const [identity] = await orm.em.fork().execute<{ backend_pid: number }[]>('select pg_backend_pid() as backend_pid');
  const input = createInterface({ input: process.stdin });
  const start = new Promise<void>(resolve => input.once('line', () => { input.close(); process.stdin.destroy(); resolve(); }));
  writeSync(1, JSON.stringify({ type: 'ready', pid: process.pid, backendPid: identity?.backend_pid }) + '\n');
  await start;
  let published = 0;
  for (let i = 0; i < 10000; i++) {
    const result = await publisher.publishNext();
    if (result.action === 'idle') break;
    if (result.action !== 'published') throw new Error('Publisher test did not complete an event');
    published++;
    if (i === 9999) throw new Error('Publisher test drain limit exceeded');
  }
  writeSync(1, JSON.stringify({ type: 'done', published, pid: process.pid }) + '\n');
} finally { client.destroy(); await orm.close(true); }
