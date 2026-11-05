import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/database/config';
import { PostgresUnitOfWork } from '../../src/database/postgres-unit-of-work';
import { PendingReferenceWorker, type PendingCandidate } from '../../src/modules/wagering/application/pending-reference-worker';
import { pendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { testDatabaseUrl } from './postgres';

const schema = process.env['JUNGLE_TEST_SCHEMA'] ?? ''; const at = new Date(process.env['JUNGLE_TEST_PENDING_NOW'] ?? '');
if (!/^jungle_it_[a-f0-9]{32}$/.test(schema) || !Number.isFinite(at.getTime())) throw new Error('Invalid isolated pending test configuration');
const candidate: PendingCandidate | undefined = process.env['JUNGLE_TEST_PENDING_CANDIDATE']
  ? JSON.parse(process.env['JUNGLE_TEST_PENDING_CANDIDATE']) as PendingCandidate : undefined;
const orm = await MikroORM.init({ ...databaseConfig(testDatabaseUrl(), schema), pool: { min: 0, max: 1 } });
try {
  const worker = new PendingReferenceWorker(new PostgresUnitOfWork(orm), { now: () => new Date(at) }, pendingReferencePolicy(), { diagnose: () => {} });
  const [row] = await orm.em.fork().execute<{ backend_pid: number }[]>('select pg_backend_pid() as backend_pid');
  const input = createInterface({ input: process.stdin });
  const start = new Promise<void>(resolve => input.once('line', () => { input.close(); process.stdin.destroy(); resolve(); }));
  writeSync(1, JSON.stringify({ type: 'ready', pid: process.pid, backendPid: row?.backend_pid }) + '\n');
  await start;
  const results = candidate ? [await worker.resolve(candidate)] : await worker.runOnce();
  writeSync(1, JSON.stringify({ type: 'done', pid: process.pid, results }) + '\n');
} finally { await orm.close(true); }
