import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { databaseConfig } from '../../src/database/config';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { SqsWagerConsumer, type ConsumerDiagnostic } from '../../src/modules/messaging/application/sqs-wager-consumer';
import { IdempotencyConflictError } from '../../src/shared/domain/domain-errors';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { createHarness, request, testDatabaseUrl, type Harness } from '../support/postgres';
import { createSqsHarness } from '../support/sqs';
import { processClient } from '../support/process-client';
import { pendingWorkerChild } from '../support/pending-worker-client';
import { pendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { localSqsClient } from '../../src/modules/messaging/infrastructure/local-sqs-client';
import type { FinancialUnitOfWork } from '../../src/shared/application/financial-store';

/** RED gate execution filter: --test-name-pattern NO_MIGRATION
 * MIGRATION_REQUIRED tests invoke the existing isolated harness, and must NOT be
 * run until Luís separately authorizes its Migration202611040001.up().
 * No test silently skips unavailable infrastructure or substitutes a mock for SQS.
 */
type Log = Record<string, unknown>;
type Sink = (record: Log) => unknown;

/** Complementary RED authorization: fail closed before the harness runs migrations.
 * Instrument only this test process; restore the migrator method after preparation.
 * createHarness uses CREATE SCHEMA without IF NOT EXISTS, so an existing schema is
 * never adopted. No production code or shared harness is changed.
 */
async function checkedHarness() {
  const original = Migrator.prototype.up;
  Migrator.prototype.up = async function (...args: Parameters<Migrator['up']>) {
    const em = Reflect.get(this, 'em') as MikroORM['em'];
    const schema = em.config.get('schema');
    if (typeof schema !== 'string' || !/^jungle_it_[a-f0-9]{32}$/.test(schema)) throw new Error('Refusing unexpected migration schema');
    const migrations = em.config.get('migrations').migrationsList;
    if (migrations?.length !== 1 || migrations[0] !== (await import('../../src/database/migrations/Migration202611040001')).Migration202611040001) {
      throw new Error('Refusing unexpected migration inventory');
    }
    const [target] = await em.getConnection().execute<Array<{ database: string; schema: string; search_path: string }>>(
      "select current_database() as database,current_schema() as schema,current_setting('search_path') as search_path");
    if (target?.database !== 'jungle_test' || target.schema !== schema || target.search_path.replaceAll(' ', '') !== `${schema},public`) {
      throw new Error('Refusing unexpected migration destination or search_path');
    }
    console.info(JSON.stringify({ verification: 'RED migration destination', ...target, migrations: ['Migration202611040001'], direction: 'up' }));
    return original.apply(this, args);
  };
  try { return await createHarness(); }
  finally { Migrator.prototype.up = original; }
}

test('B05 NO_MIGRATION existing process-client ready/result parsing with real PostgreSQL and pre-UoW rejection', async () => {
  // Deliberately uncreated schema: invalid input is rejected before any financial SQL.
  // This is a protocol/error-path proof, not a successful financial integration.
  const schema = `jungle_it_${randomUUID().replaceAll('-', '')}`;
  const client = await processClient({ url: testDatabaseUrl(), schema } as Harness);
  try {
    expect(client.pid).toBeGreaterThan(0); expect(client.backendPid).toBeGreaterThan(0);
    const outcome = await client.run(request({ id: 'invalid-wallet', playerId: 'test-player' }));
    expect(outcome.ok).toBe(false); expect(outcome.error).toBe('InvalidDomainInputError');
  } finally { await client.close(); }
}, 20000);

test('B05 NO_MIGRATION real child stdout protocol and shutdown diagnostics stay separate from new stderr logs', async () => {
  // Inline child fixture uses the actual consumer and WorkerShutdown, no helper file.
  const code = `
    import { SqsWagerConsumer } from './src/modules/messaging/application/sqs-wager-consumer';
    import { consumerConfig } from './src/modules/messaging/application/consumer-config';
    import { WorkerShutdown } from './src/shared/application/worker-shutdown';
    const frame = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const diagnostics = [];
    const consumer = Reflect.construct(SqsWagerConsumer, [
      {execute: async () => { throw new Error('must not process malformed JSON'); }},
      {receive: async () => undefined, acknowledge: async () => {}, retry: async () => {}, deadLetter: async () => {}},
      {now: () => new Date()}, consumerConfig({}), event => diagnostics.push(event),
      {operationalLog: record => process.stderr.write(JSON.stringify(record)+'\\n')}
    ]);
    frame({type:'ready'});
    const result = await consumer.handle({body:'invalid-json',transportMessageId:'sqs-real-fixture',receiptHandle:'SYNTHETIC_PRIVATE',receiveCount:1});
    frame({type:'result',result});
    const shutdown = new WorkerShutdown('protocol-test',{diagnose: frame,forceExit: () => {throw new Error('unexpected force exit');}});
    shutdown.start(async () => {});
    await shutdown.drain(); shutdown.complete();
    frame({type:'done',diagnostics});
  `;
  const child = Bun.spawn([process.execPath, '-e', code], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(0);
  const frames = stdout.trim().split('\n').map(line => JSON.parse(line) as Log);
  expect(frames.map(frame => frame['type'] ?? frame['phase'])).toEqual(['ready', 'result', 'drain-started', 'drained', 'stopped', 'done']);
  const diagnostics = frames.at(-1)?.['diagnostics'] as Array<Log>;
  expect(diagnostics).toHaveLength(1); expect(diagnostics[0]).toMatchObject({ action: 'dead-lettered', code: 'INVALID_INPUT' });
  const operations = stderr.trim() ? stderr.trim().split('\n').map(line => JSON.parse(line) as Log) : [];
  expect(operations.map(record => record['event'])).toEqual(['sqs_received', 'sqs_dead_lettered']);
  expect(operations.every(record => !('phase' in record) && record['action'] !== 'started')).toBe(true);
  expect(stderr).not.toContain('SYNTHETIC_PRIVATE');
});

test.each(['ack', 'retry', 'dlq'] as const)('B06 NO_MIGRATION real isolated SQS %s preserves decision and transport identity', async mode => {
  const queues = await createSqsHarness(); const records: Log[] = []; const diagnostics: ConsumerDiagnostic[] = [];
  const correlationId = randomUUID(); const messageId = randomUUID(); const transactionId = randomUUID();
  try {
    // Only processing is doubled: this test proves the real transport and logging boundary.
    // Persistent financial/inbox evidence is in the MIGRATION_REQUIRED tests below.
    const processor = { execute: async () => {
      if (mode === 'retry') throw { code: '40001' };
      if (mode === 'dlq') throw new IdempotencyConflictError('SYNTHETIC_PRIVATE_ERROR');
      return { transactionId, status: WagerTransactionStatus.Processed, balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false };
    } };
    const consumer = Reflect.construct(SqsWagerConsumer, [processor, queues.transport, { now: () => new Date() }, queues.config,
      (event: ConsumerDiagnostic) => diagnostics.push(event), { operationalLog: (record: Log) => records.push(record) }]) as SqsWagerConsumer;
    const sqsMessageId = await queues.send(JSON.stringify({ type: 'WagerTransactionRequested', messageId, correlationId,
      occurredAt: new Date().toISOString(), data: request({ id: randomUUID(), playerId: 'test-player' }) }));
    const message = await queues.receiveSource();
    expect(message.transportMessageId).toBe(sqsMessageId);
    const outcome = await consumer.handle(message);
    expect(outcome.action).toBe(mode === 'ack' ? 'acked' : mode === 'retry' ? 'retry' : 'dead-lettered');
    if (mode === 'dlq') {
      const dead = await queues.readDlq(); expect(dead).toBeDefined(); expect(dead!.Body).not.toContain('SYNTHETIC_PRIVATE_ERROR');
    }
    const attrs = await queues.client.send(new (await import('@aws-sdk/client-sqs')).GetQueueAttributesCommand({
      QueueUrl: queues.inputUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    const pending = Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    expect(pending).toBe(mode === 'retry' ? 1 : 0);
    expect(records.map(record => record['event'])).toEqual(['sqs_received', mode === 'ack' ? 'sqs_acked' : mode === 'retry' ? 'sqs_retry_scheduled' : 'sqs_dead_lettered']);
    expect(records[0]).toMatchObject({ messageId, sqsMessageId, correlationId });
    expect(JSON.stringify(records)).not.toContain(message.receiptHandle);
    expect(JSON.stringify(records)).not.toContain('90.00');
  } finally {
    await queues.close();
    // Check cleanup even when the expected missing-event assertion failed above.
    const verifier = localSqsClient();
    try {
      for (const QueueName of [queues.inputName, queues.dlqName]) {
        let code = '';
        try { await verifier.send(new GetQueueUrlCommand({ QueueName }), { abortSignal: AbortSignal.timeout(3000) }); }
        catch (error) { code = error instanceof Error ? error.name : ''; }
        expect(['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']).toContain(code);
      }
    } finally { verifier.destroy(); }
  }
}, 20000);

test('B06 MIGRATION_REQUIRED confirmed wallet/wager/replay logs follow commits and do not duplicate SQL effects', async () => {
  const h = await checkedHarness(); const records: Log[] = [];
  const opts = { now: () => new Date(), operationalLog: (record: Log) => { records.push(record); } };
  try {
    const wallet = await new CreateWalletUseCase(h.uow, opts).execute({ playerId: `logging-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: randomUUID() });
    const input = request(wallet); const process = new ProcessWagerTransactionUseCase(h.uow, opts);
    const result = await process.execute(input); const replay = await process.execute(input);
    expect(replay.transactionId).toBe(result.transactionId); expect(replay.idempotentReplay).toBe(true);
    expect((await h.get.execute(wallet.id)).balance.toString()).toBe('90.00');
    const counts = await h.orm.em.getConnection().execute<Array<{ ledger: number; wagers: number; outbox: number }>>(
      'select (select count(*)::int from wallet_ledger_entries) ledger, (select count(*)::int from wager_transactions) wagers, (select count(*)::int from outbox_messages) outbox');
    expect(counts[0]).toEqual({ ledger: 2, wagers: 2, outbox: 4 });
    // Exercise the existing client unchanged; no sink means no extra protocol frames.
    const pending = await pendingWorkerChild(h, new Date(), pendingReferencePolicy({}));
    try {
      pending.start(); expect(await pending.done).toBe(0);
      expect(pending.records.map(record => record.type)).toEqual(['ready', 'done']);
      expect(pending.records.at(-1)?.results).toEqual([]);
    } finally { await pending.close(); }
    expect(records.map(record => record['event'])).toEqual(['wallet_created', 'wager_processed', 'wager_replayed']);
    expect(records[2]).toMatchObject({ transactionId: result.transactionId, correlationId: input.correlationId });
  } finally { await h.close(); }
}, 20000);

test('B06 MIGRATION_REQUIRED real rollback then retry emits only final committed result', async () => {
  const h = await checkedHarness(); const records: Log[] = []; let attempts = 0;
  try {
    const wallet = await h.wallet();
    const uow: FinancialUnitOfWork = { run: (work, isolation) => h.uow.run(async store => {
      const result = await work(store);
      if (++attempts === 1) throw { code: '40001' }; // Force real PostgreSQL rollback of all first-attempt writes.
      return result;
    }, isolation) };
    const opts = { now: () => new Date(), operationalLog: (record: Log) => { records.push(record); } };
    const result = await new ProcessWagerTransactionUseCase(uow, opts).execute(request(wallet));
    expect(attempts).toBe(2); expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect((await h.get.execute(wallet.id)).balance.toString()).toBe('90.00');
    expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
    expect(records.map(record => record['event'])).toEqual(['wager_processed']);
  } finally { await h.close(); }
}, 20000);

test('B05 NO_MIGRATION PostgreSQL target/version evidence uses only read queries and closes ORM', async () => {
  const orm = await MikroORM.init(databaseConfig(testDatabaseUrl()));
  try {
    const rows = await orm.em.getConnection().execute<Array<{ database: string; version: string }>>('select current_database() as database, current_setting(\'server_version_num\') as version');
    expect(rows[0]?.database).toBe('jungle_test'); expect(rows[0]?.version.startsWith('16')).toBe(true);
  } finally { await orm.close(true); }
});

// GREEN additions preserve all eight integration RED tests above.
test('B05 NO_MIGRATION closed stderr cannot replace a result or crash the logging caller', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    import { closeSync } from 'node:fs';
    import { stderrOperationalLog } from './src/shared/infrastructure/structured-logger';
    closeSync(2);
    stderrOperationalLog({component:'wallets',event:'wallet_created'});
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({type:'result',ok:true}));
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(stdout).toBe('{"type":"result","ok":true}\n'); expect(stderr).toBe('');
});

test('B05 NO_MIGRATION structured writer keeps operational records off stdout and consumes both channels as NDJSON', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    import { stderrOperationalLog } from './src/shared/infrastructure/structured-logger';
    console.log(JSON.stringify({type:'ready'}));
    stderrOperationalLog({component:'wallets',event:'wallet_created'});
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({type:'done'}));
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(stdout.trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['ready', 'done']);
  const records = stderr.trim().split('\n').map(line => JSON.parse(line) as Log);
  expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ component: 'wallets', event: 'wallet_created' });
  expect(records[0]).not.toHaveProperty('phase'); expect(records[0]?.['action']).not.toBe('started');
});

// Corrective RED with the real Bun.stderr writer: no database, queues or migrations.
test('REV06 RED NO_MIGRATION real Bun.stderr preserves two consecutive records in order', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    import { stderrOperationalLog } from './src/shared/infrastructure/structured-logger';
    console.log(JSON.stringify({type:'ready'}));
    stderrOperationalLog({component:'wallets',event:'wallet_created'});
    stderrOperationalLog({component:'wagering',event:'wager_processed'});
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({type:'done'}));
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(stdout.trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['ready', 'done']);
  const records = stderr.trim().split('\n').map(line => JSON.parse(line) as Log);
  expect(records.map(record => record['event'])).toEqual(['wallet_created', 'wager_processed']);
  for (const record of records) { expect(record).not.toHaveProperty('phase'); expect(record['action']).not.toBe('started'); }
});

test('REV06 RED NO_MIGRATION real Bun.stderr preserves concurrent observations', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    import { stderrOperationalLog } from './src/shared/infrastructure/structured-logger';
    await Promise.all([
      Promise.resolve().then(() => stderrOperationalLog({component:'wallets',event:'wallet_created'})),
      Promise.resolve().then(() => stderrOperationalLog({component:'wagering',event:'wager_processed'}))
    ]);
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({type:'result',ok:true}));
  `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(stdout).toBe('{"type":"result","ok":true}\n');
  expect(stderr.trim().split('\n').map(line => JSON.parse(line).event)).toEqual(['wallet_created', 'wager_processed']);
});
