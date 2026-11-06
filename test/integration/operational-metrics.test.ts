import 'reflect-metadata';
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { DatabaseModule } from '../../src/database/database.module';
import { MessagingModule } from '../../src/modules/messaging/messaging.module';
import { WageringModule } from '../../src/modules/wagering/wagering.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase, type ProcessWagerInput } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { SqsWagerConsumer } from '../../src/modules/messaging/application/sqs-wager-consumer';
import { consumerConfig } from '../../src/modules/messaging/application/consumer-config';
import type { PublisherOptions } from '../../src/modules/messaging/application/outbox-publisher';
import { OutboxPublisher } from '../../src/modules/messaging/application/outbox-publisher';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { ConflictError, RetryExhaustedError } from '../../src/shared/application/application-errors';
import { IdempotencyConflictError } from '../../src/shared/domain/domain-errors';
import type { FinancialStore, FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { createHarness, testDatabaseUrl } from '../support/postgres';
import { createSqsHarness } from '../support/sqs';
import { createOutboxSqsHarness } from '../support/outbox-sqs';
import { databaseConfig } from '../../src/database/config';
import { PostgresUnitOfWork } from '../../src/database/postgres-unit-of-work';
import { DefaultOperationalMetricsCollector, OPERATIONAL_METRICS, type OperationalMetricsCollector } from '../../src/shared/application/operational-metrics';
import { GetWalletUseCase, ListWalletLedgerUseCase, ReconcileWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { GetWagerTransactionUseCase } from '../../src/modules/wagering/application/get-wager-transaction.use-case';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { ConsumerLifecycle } from '../../src/modules/messaging/infrastructure/consumer-lifecycle';
import { PublisherLifecycle } from '../../src/modules/messaging/infrastructure/publisher-lifecycle';
import { PendingReferenceLifecycle } from '../../src/modules/wagering/infrastructure/pending-reference-lifecycle';
import { localSqsClient } from '../../src/modules/messaging/infrastructure/local-sqs-client';
import { closeWorkerApplication } from '../../src/shared/application/worker-signals';

type Observation = (event: unknown) => void;
const at = new Date('2026-11-05T12:00:00.000Z');
const correlationId = randomUUID();

/** Migration guard for tests explicitly named MIGRATION_REQUIRED. These tests are
 * compiled in this RED gate but must not be run by the NO_MIGRATION invocation. */
async function checkedHarness() {
  const original = Migrator.prototype.up;
  Migrator.prototype.up = async function (...args: Parameters<Migrator['up']>) {
    const em = Reflect.get(this, 'em') as MikroORM['em'];
    const schema = em.config.get('schema');
    if (typeof schema !== 'string' || !/^jungle_it_[a-f0-9]{32}$/.test(schema)) throw new Error('Refusing unexpected RED migration schema');
    const migrations = em.config.get('migrations').migrationsList;
    if (migrations?.length !== 2 || migrations[0] !== (await import('../../src/database/migrations/Migration202611040001')).Migration202611040001
      || migrations[1] !== (await import('../../src/database/migrations/Migration202611060001')).Migration202611060001) {
      throw new Error('Refusing unexpected RED migration inventory');
    }
    const [target] = await em.getConnection().execute<Array<{ database: string; schema: string; search_path: string }>>(
      "select current_database() as database,current_schema() as schema,current_setting('search_path') as search_path");
    if (target?.database !== 'jungle_test' || target.schema !== schema || target.search_path.replaceAll(' ', '') !== `${schema},public`) {
      throw new Error('Refusing unexpected RED migration destination or search_path');
    }
    return original.apply(this, args);
  };
  try { return await createHarness(); }
  finally { Migrator.prototype.up = original; }
}

function inputFor(wallet: { id: string; playerId: string }, overrides: Partial<ProcessWagerInput> = {}): ProcessWagerInput {
  const externalTransactionId = randomUUID();
  return { walletId: wallet.id, playerId: wallet.playerId, providerId: 'provider-metrics-test', externalTransactionId,
    idempotencyKey: `metrics:${externalTransactionId}`, roundId: 'round-metrics', gameId: 'game-metrics', kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' }, correlationId, ...overrides };
}

/** In-memory financial boundary keeps these real-SQS scenarios independent of PostgreSQL/migrations. */
function inMemoryFinancial() {
  const wallet = Wallet.rehydrate({ id: randomUUID(), playerId: `player-${randomUUID()}`, currency: 'BRL', balance: Money.from({ amount: '100.00', currency: 'BRL' }),
    version: 1, createdAt: at, updatedAt: at });
  const identities: WagerTransaction[] = []; const ledger: unknown[] = []; const outbox: OutboxMessage[] = [];
  const store: Partial<FinancialStore> = {
    getWallet: async id => id === wallet.id ? wallet : undefined,
    updateWallet: async () => {},
    findIdentity: async (key, providerId, externalId) => identities.filter(tx =>
      (tx.idempotencyKey === key && tx.providerId === providerId) || (tx.providerId === providerId && tx.externalTransactionId === externalId)),
    getWager: async id => identities.find(tx => tx.id === id), findWager: async () => undefined, isReversed: async () => false,
    insertWager: async tx => { identities.push(tx); }, appendLedger: async entry => { ledger.push(entry); },
    enqueue: async event => { outbox.push(event); }, claimInbox: async message => ({ inserted: true, message }), finishInbox: async () => {},
  };
  const uow: FinancialUnitOfWork = { run: async work => work(store as FinancialStore) };
  return { wallet, identities, ledger, outbox, store, uow, input: inputFor(wallet) };
}

function queueEnvelope(input: ProcessWagerInput): string {
  return JSON.stringify({ type: 'WagerTransactionRequested', messageId: randomUUID(), correlationId, occurredAt: at.toISOString(), data: input });
}

async function queueCounts(sqs: Awaited<ReturnType<typeof createSqsHarness>>, queueUrl: string) {
  const result = await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }), { abortSignal: AbortSignal.timeout(5000) });
  return result.Attributes ?? {};
}

g6aTest('RED-C11 NO_MIGRATION real LocalStack Consumer ACK confirms source deletion without duplicate M1/M2 metrics', async () => {
  const sqs = await g6aSqsHarness(); const observations: unknown[] = []; const financial = inMemoryFinancial();
  try {
    const sentId = await sqs.send(queueEnvelope(financial.input), financial.wallet.id);
    const message = await sqs.receiveSource(); expect(message.transportMessageId).toBe(sentId); expect(message.receiveCount).toBe(1);
    const observe = (event: unknown) => { observations.push(event); };
    const processor = new ProcessWagerTransactionUseCase(financial.uow,
      { now: () => at, operationalMetrics: observe } as unknown as ConstructorParameters<typeof ProcessWagerTransactionUseCase>[1]);
    let observationsBeforeProcessor = 0; let observationsAfterProcessor = 0;
    const wrappedProcessor = { execute: async (input: ProcessWagerInput) => {
      observationsBeforeProcessor = observations.length;
      const result = await processor.execute(input);
      observationsAfterProcessor = observations.length;
      return result;
    } };
    const options = { operationalMetrics: observe } as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5];
    const consumer = new SqsWagerConsumer(wrappedProcessor, sqs.transport, { now: () => at }, sqs.config, () => {}, options);
    const result = await consumer.handle(message);
    expect(result.action).toBe('acked');
    if (result.action !== 'acked') throw new Error('Expected acked result before financial assertions');
    expect(result.result.status).toBe(WagerTransactionStatus.Processed); expect(result.result.idempotentReplay).toBe(false);
    expect(financial.wallet.balance.toString()).toBe('90.00'); expect(financial.identities).toHaveLength(1);
    expect(financial.ledger).toHaveLength(1); expect(financial.outbox).toHaveLength(2);
    const sourceCounts = await queueCounts(sqs, sqs.inputUrl);
    expect(sourceCounts['ApproximateNumberOfMessages']).toBe('0'); expect(sourceCounts['ApproximateNumberOfMessagesNotVisible']).toBe('0');
    // The financial use case owns M1/M2; the Consumer must not add a generic ACK observation afterwards.
    expect(observations.slice(observationsBeforeProcessor, observationsAfterProcessor)).toHaveLength(2);
    expect(observations[observationsBeforeProcessor]).toEqual({ type: 'wager-status', status: 'PROCESSED' });
    expect(observations[observationsBeforeProcessor + 1]).toMatchObject({ type: 'processing-duration' });
    expect(observations.slice(observationsAfterProcessor)).toEqual([]);
    const duration = observations[observationsBeforeProcessor + 1] as { durationMs: number };
    expect(Number.isSafeInteger(duration.durationMs)).toBe(true); expect(duration.durationMs).toBeGreaterThanOrEqual(0);
    await g6aEmptyQueue(sqs, sqs.dlqUrl);
  } finally { await sqs.close(); }
});

g6aTest('RED-C11 NO_MIGRATION real LocalStack Consumer retry preserves redelivery below maxReceiveCount', async () => {
  const sqs = await g6aSqsHarness(); const observations: unknown[] = [];
  try {
    const input = inputFor({ id: randomUUID(), playerId: `retry-${randomUUID()}` });
    const sentId = await sqs.send(queueEnvelope(input), input.walletId);
    const first = await sqs.receiveSource(); expect(first.transportMessageId).toBe(sentId); expect(first.receiveCount).toBe(1);
    const options = { operationalMetrics: (event: unknown) => { observations.push(event); } } as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5];
    const consumer = new SqsWagerConsumer({ execute: async () => { throw new RetryExhaustedError('synthetic exhausted UoW retry', { cause: { code: '40001' } }); } },
      sqs.transport, { now: () => at }, sqs.config, () => {}, options);
    const result = await consumer.handle(first);
    expect(result).toEqual({ action: 'retry', code: 'POSTGRES_TRANSIENT' });
    const redelivered = await sqs.receiveSource();
    expect(redelivered.transportMessageId).toBe(sentId); expect(redelivered.body).toBe(first.body);
    expect(redelivered.receiveCount).toBe(2); expect(redelivered.receiveCount).toBeLessThan(sqs.config.maxReceiveCount);
    expect(observations).toEqual([{ type: 'retry-scheduled', target: 'sqsConsumer' }]);
    await g6aEmptyQueue(sqs, sqs.dlqUrl);
  } finally { await sqs.close(); }
});

g6aTest('RED-C11 NO_MIGRATION real LocalStack Consumer DLQ observes only confirmed transfer and sanitizes payload', async () => {
  const sqs = await g6aSqsHarness(); const observations: unknown[] = []; const sensitiveBody = 'malformed-SYNTHETIC_SECRET-payload';
  try {
    const sentId = await sqs.send(sensitiveBody);
    const message = await sqs.receiveSource(); expect(message.transportMessageId).toBe(sentId); expect(message.receiveCount).toBe(1);
    let processorCalls = 0;
    const options = { operationalMetrics: (event: unknown) => { observations.push(event); } } as unknown as ConstructorParameters<typeof SqsWagerConsumer>[5];
    const consumer = new SqsWagerConsumer({ execute: async () => { processorCalls++; throw new Error('invalid message must not reach processor'); } },
      sqs.transport, { now: () => at }, sqs.config, () => {}, options);
    const result = await consumer.handle(message);
    expect(result).toEqual({ action: 'dead-lettered', code: 'INVALID_INPUT' }); expect(processorCalls).toBe(0);
    const dead = await sqs.readDlq(); expect(dead?.Body).toBeString();
    const envelope = JSON.parse(dead!.Body!) as Record<string, unknown>;
    expect(envelope).toMatchObject({ type: 'WagerTransactionDeadLetter', version: 1, sourceMessageId: sentId, errorCode: 'INVALID_INPUT', receiveCount: 1 });
    expect(dead!.Body).not.toContain(sensitiveBody); expect(envelope).not.toHaveProperty('body');
    const sourceCounts = await queueCounts(sqs, sqs.inputUrl);
    expect(sourceCounts['ApproximateNumberOfMessages']).toBe('0'); expect(sourceCounts['ApproximateNumberOfMessagesNotVisible']).toBe('0');
    const dlqCounts = await queueCounts(sqs, sqs.dlqUrl);
    expect(Number(dlqCounts['ApproximateNumberOfMessages']) + Number(dlqCounts['ApproximateNumberOfMessagesNotVisible'])).toBe(1);
    expect(observations).toEqual([{ type: 'dlq-transfer-confirmed' }]); // Only after SendMessage and source DeleteMessage both succeed.
    expect(envelope['bodyHash']).toBe(createHash('sha256').update(sensitiveBody).digest('hex'));
    expect(dead!.Attributes?.MessageGroupId).toMatch(/^dlq-/);
    expect(dead!.Attributes?.MessageDeduplicationId).toMatch(/^[a-f0-9]{64}$/);
  } finally { await sqs.close(); }
});

g6aTest('RED-C11 NO_MIGRATION real LocalStack Outbox send is isolated from metrics observation', async () => {
  const sqs = await g6aOutboxHarness(); const observations: unknown[] = []; const eventId = randomUUID(); const aggregateId = randomUUID();
  try {
    const message = OutboxMessage.rehydrate({ id: eventId, aggregateId, eventType: 'WalletBalanceChanged', occurredAt: at, attempts: 0,
      nextAttemptAt: at, payload: { eventId, aggregateId, eventType: 'WalletBalanceChanged', occurredAt: at.toISOString(), correlationId, data: { balance: { amount: '9.00', currency: 'BRL' } } } });
    const store = { claimNextOutbox: async (_worker: string, token: string, _now: Date, leaseUntil: Date) => ({ message, workerId: 'red-test', leaseToken: token, leaseUntil }),
      completeOutbox: async () => true, failOutbox: async () => true };
    const uow = { run: async <T>(work: (s: never) => Promise<T>) => work(store as never) };
    const options = { workerId: 'metrics-red', operationalMetrics: (event: unknown) => observations.push(event) } as unknown as PublisherOptions;
    const publisher = new OutboxPublisher(uow, sqs.transport, { now: () => at }, workerConfig({}), options);
    expect((await publisher.publishNext()).action).toBe('published');
    const messages = await sqs.read(); expect(messages).toHaveLength(1); expect(messages[0]?.payload['eventId']).toBe(eventId);
    expect(observations).toEqual([{ type: 'outbox-publication-confirmed', lagMs: 0 }]);
    expect(messages[0]?.groupId).toBe(aggregateId); expect(messages[0]?.dedupId).toBe(eventId);
    const nextId = randomUUID(); const next = OutboxMessage.rehydrate({ id: nextId, aggregateId, eventType: 'WalletBalanceChanged', occurredAt: at,
      attempts: 0, nextAttemptAt: at, payload: { ...message.payload, eventId: nextId } });
    const failObserverWork: FinancialUnitOfWork = { run: async work => work({ ...store,
      claimNextOutbox: async (_owner: string, token: string, _now: Date, leaseUntil: Date) => ({ message: next, workerId: 'red-test', leaseToken: token, leaseUntil }),
    } as unknown as FinancialStore) };
    let observerCalls = 0;
    const hostile = new OutboxPublisher(failObserverWork, sqs.transport, { now: () => at }, workerConfig({}), {
      workerId: 'g6a-observer', operationalMetrics: () => { observerCalls++; throw new Error('synthetic observer failure'); },
    });
    expect((await hostile.publishNext()).action).toBe('published'); expect(observerCalls).toBe(1);
    const delivered = await sqs.read(); expect(delivered).toHaveLength(1); expect(delivered[0]?.payload['eventId']).toBe(nextId);
    expect(delivered[0]?.groupId).toBe(aggregateId); expect(delivered[0]?.dedupId).toBe(nextId);
  } finally { await sqs.close(); }
});

g6aTest('RED-C12 NO_MIGRATION standalone HTTP child keeps NDJSON protocol clean and its metrics scope local', async () => {
  const parentCollector = new DefaultOperationalMetricsCollector(); parentCollector.observe({ type: 'duplicate', kind: 'replay' });
  const source = `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
const uow={run:async()=>{throw new Error('metrics must not touch financial UoW')}};
if(new URL(process.env.DATABASE_URL).pathname!=='/jungle_test')throw new Error('Unsafe child database');
const app=await NestFactory.create(AppModule.register({uow}),{logger:false,abortOnError:false});
try {
await app.listen(0,'127.0.0.1');
console.log(JSON.stringify({type:'ready'}));
const response=await fetch((await app.getUrl())+'/metrics');
const body=await response.json();
console.log(JSON.stringify({type:'result',status:response.status,scope:body.scope,snapshot:body}));
} finally { await app.close(); }
console.log(JSON.stringify({type:'done'}));`;
  const { stdout, stderr, exitCode } = await g6aChild(source);
  expect(exitCode).toBe(0); expect(stderr).toBe('');
  const frames = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(frames.map(frame => frame['type'])).toEqual(['ready', 'result', 'done']);
  expect(frames[0]).toEqual({ type: 'ready' });
  expect(frames[1]).toMatchObject({ type: 'result', status: 200, scope: 'process' });
  expect(frames[1]?.['snapshot']).toEqual(g6aEmptySnapshot()); expect(parentCollector.snapshot().duplicates.replays).toBe(1);
});

test('RED-C11 MIGRATION_REQUIRED PostgreSQL wallet, wager and replay metrics follow committed financial state', async () => {
  const h = await checkedHarness();
  const app = await NestFactory.create(AppModule.register({ uow: h.uow }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const wallet = await app.get(CreateWalletUseCase).execute({ playerId: `metrics-player-${randomUUID()}`, initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId });
    const input = inputFor(wallet); const processor = app.get(ProcessWagerTransactionUseCase);
    const first = await processor.execute(input); expect(first.status).toBe(WagerTransactionStatus.Processed); expect(first.idempotentReplay).toBe(false);
    const replay = await processor.execute(input); expect(replay.transactionId).toBe(first.transactionId); expect(replay.idempotentReplay).toBe(true);
    const response = await fetch(`${await app.getUrl()}/metrics`); expect(response.status).toBe(200);
    const body = await response.json() as { transactionsByStatus: { PROCESSED: number }; duplicates: { replays: number } };
    expect(body.transactionsByStatus.PROCESSED).toBe(1); expect(body.duplicates.replays).toBe(1);
  } finally { await app.close(); await h.close(); }
});
test('RED-C11 MIGRATION_REQUIRED PostgreSQL rollback and retry produce one committed status observation', async () => {
  const h = await checkedHarness(); let failBeforeCommit = true;
  const retryUow: FinancialUnitOfWork = { run: async (work, isolation) => h.uow.run(async store => {
    const result = await work(store);
    if (failBeforeCommit) { failBeforeCommit = false; throw { code: '40001' }; }
    return result;
  }, isolation) };
  const app = await NestFactory.create(AppModule.register({ uow: retryUow }), { logger: false, abortOnError: false });
  try {
    const wallet = await h.wallet('100.00');
    await app.listen(0, '127.0.0.1');
    const processor = app.get(ProcessWagerTransactionUseCase);
    const result = await processor.execute(inputFor(wallet)); expect(result.status).toBe(WagerTransactionStatus.Processed);
    const response = await fetch(`${await app.getUrl()}/metrics`); expect(response.status).toBe(200);
    const body = await response.json() as { transactionsByStatus: { PROCESSED: number }; retries: { wagerUow: number } };
    expect(body.transactionsByStatus.PROCESSED).toBe(1); expect(body.retries.wagerUow).toBe(1);
  } finally { await app.close(); await h.close(); }
});

// E3 authorized: real external graphs run only through the guarded, sequential harness.
// Token identity needs PostgreSQL/owned queues but no migrations or financial SQL.
const c14ExternalGraphs = [
  { name: 'DatabaseModule.forRoot', kind: 'database', needs: 'PostgreSQL; NO_MIGRATION' },
  { name: 'MessagingModule.forConsumer', kind: 'consumer', needs: 'PostgreSQL and isolated SQS; NO_MIGRATION' },
  { name: 'MessagingModule.forPublisher', kind: 'publisher', needs: 'PostgreSQL and isolated SQS; NO_MIGRATION' },
  { name: 'WageringModule.forPendingReferences', kind: 'pending', needs: 'PostgreSQL; NO_MIGRATION' },
] as const;
for (const graph of c14ExternalGraphs) {
  g6aTest(`RED-C14 ${graph.name} provides stable per-graph OPERATIONAL_METRICS identity [${graph.needs}]`, async () => {
    await g6aGraphSequence(graph.kind);
  });
}

// No I/O, patches or bootstrap occur at module evaluation. Each scenario enters g6aScenario exactly once.
type G6aGraph = 'database' | 'consumer' | 'publisher' | 'pending';
type G6aOwnedQueue = { name: string; url: string; arn?: string };
type G6aProbe = { store?: Partial<FinancialStore>; failure?: unknown };
const g6aOwnedName = /^jungle_it_[a-f0-9]{32}_(input|dlq|events)\.fifo$/;
const g6aIdentitySql = `select current_database() as db,current_schema() as schema,
  current_setting('search_path') as search_path,current_setting('server_version_num') as version,
  current_setting('transaction_read_only') as read_only,current_user as role,
  has_database_privilege(current_user,current_database(),'CONNECT') as can_connect,
  has_schema_privilege(current_user,'public','USAGE') as can_use_public,pg_backend_pid() as backend_pid`;
const g6aPublicSql = `select c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','v','m','S','f') order by c.relname`;
type G6aIdentity = { db: string; schema: string; search_path: string; version: string; read_only: string;
  role: string; can_connect: boolean; can_use_public: boolean; backend_pid?: number };
let g6aBusy = false; let g6aStopped = false;
let g6aBlockedMigrationCalls = 0;

function g6aMigrationBarrier(): () => void {
  const original = Migrator.prototype.up;
  const blocked: typeof original = async function () { g6aBlockedMigrationCalls++; throw new Error('G6A prohibits Migrator.up; G6B is not authorized'); };
  Migrator.prototype.up = blocked;
  return () => { Migrator.prototype.up = original; };
}
afterAll(() => {
  console.log(JSON.stringify({ component: 'g6a-migrations', blockedCalls: g6aBlockedMigrationCalls, executed: 0 }));
});

function g6aTarget(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid G6A test destination'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '5434' || url.pathname !== '/jungle_test' || url.search || url.hash) {
    throw new Error('G6A requires jungle_test on the authorized local test port 5434');
  }
  return value;
}
function g6aCheckEnv(testUrl: string, absentEnv: string): void {
  g6aTarget(testUrl);
  if (process.env['DATABASE_URL'] !== testUrl || process.env['TEST_DATABASE_URL'] !== testUrl
    || process.env['MIKRO_ORM_ENV'] !== absentEnv || existsSync(absentEnv)) throw new Error('Unverified G6A effective environment');
  // Configuration.sync() writes this cosmetic flag itself, including during Nest descriptor construction.
  // Remove only its boolean value inside the already verified scope; connection/schema overrides still fail closed.
  if (['true', 'false'].includes(process.env['MIKRO_ORM_COLORS'] ?? '')) delete process.env['MIKRO_ORM_COLORS'];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MIKRO_ORM_') && key !== 'MIKRO_ORM_ENV') throw new Error(`G6A conflicting ORM environment key: ${key}`);
  }
  const endpoint = new URL(process.env['SQS_ENDPOINT'] ?? 'http://127.0.0.1:4566');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.port !== '4566'
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error('Unverified G6A LocalStack destination');
  }
}
async function g6aWithTestEnv<T>(overrides: Readonly<Record<string, string>>, work: (testUrl: string, absentEnv: string) => Promise<T>): Promise<T> {
  const testUrl = g6aTarget(testDatabaseUrl());
  const enclosing = process.env['MIKRO_ORM_ENV'];
  if (['true', 'false'].includes(process.env['MIKRO_ORM_COLORS'] ?? '')) delete process.env['MIKRO_ORM_COLORS'];
  if (Object.keys(process.env).some(key => key.startsWith('MIKRO_ORM_') && !(key === 'MIKRO_ORM_ENV'
    && enclosing && /^\/tmp\/jungle-g6a-mikro-[a-f0-9-]+\.absent$/.test(enclosing)))) throw new Error('Preexisting MIKRO_ORM override is not authorized');
  const absentEnv = enclosing ?? `/tmp/jungle-g6a-mikro-${randomUUID()}.absent`;
  if (existsSync(absentEnv)) throw new Error('G6A dotenv sentinel must not exist');
  const values = { DATABASE_URL: testUrl, MIKRO_ORM_ENV: absentEnv, ...overrides };
  const saved = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    g6aCheckEnv(testUrl, absentEnv); return await work(testUrl, absentEnv);
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // Rejecting overrides is preferable to silently carrying dotenv additions to the next scenario.
    for (const key of Object.keys(process.env)) if (key.startsWith('MIKRO_ORM_') && !saved.has(key)) delete process.env[key];
  }
}
async function g6aScenario(work: () => Promise<void>): Promise<void> {
  if (g6aStopped || g6aBusy) throw new Error('G6A STOP: previous failure or concurrent scenario');
  g6aBusy = true;
  const restoreMigration = g6aMigrationBarrier();
  try { await g6aWithTestEnv({}, async () => { await work(); }); }
  catch (error) {
    g6aStopped = true;
    console.log(JSON.stringify({ component: 'g6a-failure', detail: g6aFailureDetail(error) }));
    // SDK/ORM errors may contain connection configuration. Do not expose their raw object or cause.
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'UnknownFailure';
    throw new Error(`G6A STOP: scenario or cleanup failed (${name}); inspect sanitized resource audit`);
  }
  finally {
    restoreMigration();
    g6aBusy = false;
  }
}
function g6aFailureDetail(error: unknown): unknown {
  if (error instanceof AggregateError) return { name: 'AggregateError', errors: [...error.errors].map(g6aFailureDetail) };
  if (error instanceof Error) return { name: error.name,
    reason: /^(G6A|Unexpected financial)/.test(error.message) ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted-url]') : 'failure details withheld',
    location: error.stack?.split('\n').find(line => line.includes('/projects/Jungle/') && /^\s+at /.test(line))?.trim() };
  return { name: 'UnknownFailure' };
}
function g6aTest(name: string, work: () => Promise<void>): void {
  if (!name.includes('NO_MIGRATION')) throw new Error('Missing G6A selection tag');
  test(name, () => g6aScenario(work), 60000);
}
function g6aEmptySnapshot() { return new DefaultOperationalMetricsCollector().snapshot(); }
async function g6aDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
async function g6aUntil<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do { const result = await read(); if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('G6A resource confirmation deadline exceeded');
}
async function g6aChild(source: string, timeoutMs = 12000) {
  const testUrl = g6aTarget(testDatabaseUrl()); const absentEnv = process.env['MIKRO_ORM_ENV'];
  if (!absentEnv) throw new Error('Missing G6A isolated child environment');
  g6aCheckEnv(testUrl, absentEnv);
  const child = Bun.spawn([process.execPath, '-e', source], { cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl }, stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  void output.catch(() => {});
  try {
    const [stdout, stderr, exitCode] = await g6aDeadline(output, timeoutMs, 'G6A child deadline exceeded');
    return { stdout, stderr, exitCode };
  } finally {
    try { if (child.exitCode === null) child.kill('SIGKILL'); }
    finally {
      await g6aDeadline(child.exited, 5000, 'G6A child join failed; STOP');
      await g6aDeadline(output, 5000, 'G6A child pipe cleanup failed; STOP');
      console.log(JSON.stringify({ component: 'g6a-child-joined', pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
    }
  }
}

function g6aValidateIdentity(row: G6aIdentity | undefined, objects: readonly unknown[]): void {
  if (!row || row.db !== 'jungle_test' || row.schema !== 'public' || !['public', 'public,public'].includes(row.search_path.replaceAll(' ', ''))
    || !row.version.startsWith('16') || row.read_only !== 'on' || !row.can_connect || !row.can_use_public || !row.role || objects.length !== 0) {
    throw new Error('G6A STOP: database/schema/version/permissions/public inventory not verified');
  }
}
async function g6aCheckPublic(orm: MikroORM): Promise<G6aIdentity> {
  const connection = orm.em.getConnection();
  const [identity] = await connection.execute<G6aIdentity[]>(g6aIdentitySql);
  const objects = await connection.execute<unknown[]>(g6aPublicSql);
  g6aValidateIdentity(identity, objects);
  if (!Number.isSafeInteger(identity?.backend_pid) || identity!.backend_pid! < 1) throw new Error('G6A backend identity is missing');
  return identity!;
}
function g6aRestrictedStore(methods: Partial<FinancialStore>, unexpected: (name: string) => void): FinancialStore {
  return new Proxy(methods as FinancialStore, { get(target, key) {
    if (typeof key !== 'string') return undefined;
    const method = Reflect.get(target, key);
    if (typeof method === 'function') return method;
    return async () => { unexpected(key); throw new Error('Unexpected financial store access outside the approved G6A probe'); };
  } });
}
function g6aAuditSql(sql: unknown): void {
  if (typeof sql !== 'string' || ![g6aIdentitySql, g6aPublicSql, 'select 1'].includes(sql)) {
    throw new Error('G6A prohibits non-audit SQL, DDL and financial queries');
  }
}
function g6aInstallBarriers(testUrl: string, absentEnv: string) {
  g6aCheckEnv(testUrl, absentEnv);
  const init = CoreORM.init; const run = PostgresUnitOfWork.prototype.run;
  const createdOrms: MikroORM[] = []; const pendingInits = new Set<Promise<MikroORM>>();
  const counters = { init: 0, verified: 0, idleOutbox: 0, idlePending: 0, probes: 0, unexpectedStore: 0, forbiddenSql: 0 };
  const connectionRestores: Array<() => void> = []; const identities: G6aIdentity[] = [];
  let activeProbe: G6aProbe | undefined;
  const idle = g6aRestrictedStore({ claimNextOutbox: async () => { counters.idleOutbox++; return undefined; },
    findDuePendingWagers: async () => { counters.idlePending++; return []; } }, () => { counters.unexpectedStore++; });
  const wrappedInit = async function (this: typeof CoreORM, options: Parameters<typeof CoreORM.init>[0]): Promise<MikroORM> {
    g6aCheckEnv(testUrl, absentEnv);
    console.log(JSON.stringify({ component: 'g6a-init-boundary', targetMatches: options?.clientUrl === testUrl,
      schemaMatches: options?.schema === 'public', dbNameAllowed: options?.dbName === undefined || options.dbName === 'jungle_test',
      hostAllowed: options?.host === undefined || ['127.0.0.1', 'localhost'].includes(options.host),
      portAllowed: options?.port === undefined || options.port === 5434, connectDisabled: options?.connect === false,
      connectionKeys: Object.keys(options?.driverOptions?.connection ?? {}) }));
    if (!options || options instanceof Object === false || options.clientUrl !== testUrl || options.schema !== 'public'
      || (options.dbName !== undefined && options.dbName !== 'jungle_test')
      || (options.host !== undefined && !['127.0.0.1', 'localhost'].includes(options.host))
      || (options.port !== undefined && options.port !== 5434) || options.connect === false) {
      throw new Error('G6A rejected unexpected ORM init options');
    }
    const connectionOptions = options.driverOptions?.connection;
    if (!connectionOptions || typeof connectionOptions !== 'object'
      || Object.keys(connectionOptions).some(key => !['application_name', 'connectionTimeoutMillis', 'options'].includes(key))
      || connectionOptions.options !== '-c search_path=public,public') throw new Error('G6A rejected connection overrides');
    counters.init++;
    const operation = (async () => {
      const safe = { ...options, ensureDatabase: false, ensureIndexes: false, logger: () => {},
        driverOptions: { ...options.driverOptions, connection: { ...options.driverOptions?.connection,
          options: '-c search_path=public,public -c default_transaction_read_only=on' } } };
      const orm = await Reflect.apply(init, this, [safe]) as MikroORM;
      createdOrms.push(orm);
      try {
        const config = orm.config;
        if (config.get('clientUrl') !== testUrl || config.get('dbName') !== 'jungle_test' || config.get('schema') !== 'public'
          || config.get('ensureDatabase') !== false || config.get('ensureIndexes') !== false
          || config.get('driverOptions')?.connection?.options !== safe.driverOptions.connection.options) throw new Error('G6A rejected effective ORM configuration');
        const connection = orm.em.getConnection(); const execute = connection.execute;
        connection.execute = (function (...args: Parameters<typeof execute>) {
          try { g6aAuditSql(args[0]); } catch (error) { counters.forbiddenSql++; throw error; }
          return Reflect.apply(execute, connection, args);
        }) as typeof execute;
        connectionRestores.push(() => { connection.execute = execute; });
        identities.push(await g6aCheckPublic(orm)); // REV2-01: explicit real query, not isConnected().
        counters.verified++; return orm;
      } catch (error) { await orm.close(true); throw error; }
    })();
    pendingInits.add(operation);
    try { return await operation; } finally { pendingInits.delete(operation); }
  };
  CoreORM.init = wrappedInit as typeof CoreORM.init;
  PostgresUnitOfWork.prototype.run = async function <T>(work: (store: FinancialStore) => Promise<T>): Promise<T> {
    const probe = activeProbe;
    if (!probe) return work(idle);
    counters.probes++;
    if (probe.failure !== undefined) throw probe.failure;
    return work(g6aRestrictedStore(probe.store ?? {}, () => { counters.unexpectedStore++; }));
  };
  return { counters, createdOrms, identities,
    async probe<T>(value: G6aProbe, work: () => Promise<T>): Promise<T> {
      if (activeProbe) throw new Error('Concurrent G6A probe is forbidden');
      activeProbe = value;
      try { return await work(); } finally { activeProbe = undefined; }
    },
    async close(): Promise<void> {
      const failures: unknown[] = [];
      let closedOrms = 0;
      try {
        const pending = await Promise.allSettled([...pendingInits]);
        for (const result of pending) if (result.status === 'rejected') failures.push(new Error('G6A partial ORM init failed'));
        for (const orm of createdOrms) {
          try { await orm.close(true); if (await orm.isConnected()) throw new Error('G6A ORM remains connected'); closedOrms++; }
          catch { failures.push(new Error('G6A ORM cleanup failed')); }
        }
      } finally {
        connectionRestores.reverse().forEach(restore => restore());
        PostgresUnitOfWork.prototype.run = run; CoreORM.init = init;
      }
      if (counters.unexpectedStore || counters.forbiddenSql) failures.push(new Error('G6A prohibited store/SQL access detected'));
      console.log(JSON.stringify({ component: 'g6a-audit', counters, createdOrms: createdOrms.length, closedOrms, identities }));
      if (failures.length) throw new AggregateError(failures, 'G6A barrier cleanup failed');
    },
  };
}

async function g6aQueues(client: SQSClient): Promise<Set<string>> {
  const urls = new Set<string>(); let token: string | undefined;
  do {
    const result = await client.send(new ListQueuesCommand({ MaxResults: 1000, ...(token ? { NextToken: token } : {}) }), { abortSignal: AbortSignal.timeout(5000) });
    for (const url of result.QueueUrls ?? []) urls.add(url);
    token = result.NextToken;
  } while (token);
  return urls;
}
function g6aOwnQueue(queue: G6aOwnedQueue, before: ReadonlySet<string>): void {
  if (!g6aOwnedName.test(queue.name) || before.has(queue.url)) throw new Error('G6A refuses a preexisting or unowned queue');
}
function g6aMissingQueue(error: unknown): boolean {
  const name = error && typeof error === 'object' ? Reflect.get(error, 'name') : undefined;
  return name === 'QueueDoesNotExist' || name === 'AWS.SimpleQueueService.NonExistentQueue';
}
async function g6aDeleteOwned(owned: readonly G6aOwnedQueue[], before: ReadonlySet<string>,
  remove: (queue: G6aOwnedQueue) => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (const queue of owned) {
    try { g6aOwnQueue(queue, before); await remove(queue); }
    catch { failures.push(new Error(`G6A cleanup failed for ${queue.name}`)); }
  }
  if (failures.length) throw new AggregateError(failures, 'G6A independent cleanup failed');
}
async function g6aQueueAudit() {
  const client = localSqsClient(); let before: Set<string>;
  try { before = await g6aQueues(client); } catch (error) { client.destroy(); throw error; }
  const owned: G6aOwnedQueue[] = [];
  const send = SQSClient.prototype.send;
  const destroy = SQSClient.prototype.destroy; const clients = new Set<SQSClient>([client]); const destroyed = new Set<SQSClient>();
  SQSClient.prototype.destroy = function () { destroyed.add(this); destroy.call(this); };
  // Intercept creation before the existing harness can create/reuse a queue. No prefix deletion is used.
  SQSClient.prototype.send = (function (this: SQSClient, command: unknown, ...args: unknown[]) {
    clients.add(this);
    if (!(command instanceof CreateQueueCommand)) return Reflect.apply(send, this, [command, ...args]);
    const caller = this;
    return (async () => {
      const name = command.input.QueueName;
      if (!name || !g6aOwnedName.test(name)) throw new Error('G6A refused nonexclusive CreateQueue');
      try {
        await Reflect.apply(send, client, [new GetQueueUrlCommand({ QueueName: name }), { abortSignal: AbortSignal.timeout(5000) }]);
        throw new Error('G6A queue name already exists');
      } catch (error) { if (!g6aMissingQueue(error)) throw error; }
      const result = await Reflect.apply(send, caller, [command, ...args]) as { QueueUrl?: string };
      if (!result.QueueUrl) throw new Error('G6A queue creation URL not confirmed');
      const queue: G6aOwnedQueue = { name, url: result.QueueUrl }; g6aOwnQueue(queue, before); owned.push(queue);
      const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: queue.url, AttributeNames: ['QueueArn'] }), { abortSignal: AbortSignal.timeout(5000) });
      if (!attributes.Attributes?.QueueArn) throw new Error('G6A queue ARN not confirmed');
      queue.arn = attributes.Attributes.QueueArn; return result;
    })();
  }) as typeof send;
  let closed = false;
  return { client, before, owned,
    async close(harnessClose: () => Promise<void>): Promise<void> {
      if (closed) return; closed = true; SQSClient.prototype.send = send;
      const failures: unknown[] = [];
      try {
        try { await harnessClose(); } catch { failures.push(new Error('G6A harness cleanup failed')); }
        try {
          await g6aDeleteOwned(owned, before, async queue => {
            let current: string | undefined;
            try { current = (await client.send(new GetQueueUrlCommand({ QueueName: queue.name }), { abortSignal: AbortSignal.timeout(5000) })).QueueUrl; }
            catch (error) { if (g6aMissingQueue(error)) return; throw error; }
            if (current !== queue.url) throw new Error('G6A queue ownership changed');
            await client.send(new DeleteQueueCommand({ QueueUrl: queue.url }), { abortSignal: AbortSignal.timeout(5000) });
            await g6aUntil(async () => {
              try { await client.send(new GetQueueUrlCommand({ QueueName: queue.name }), { abortSignal: AbortSignal.timeout(5000) }); return undefined; }
              catch (error) { if (g6aMissingQueue(error)) return true; throw error; }
            });
          });
        } catch (error) { failures.push(error); }
        const after = await g6aQueues(client);
        if ([...before].some(url => !after.has(url)) || owned.some(queue => after.has(queue.url))) failures.push(new Error('G6A queue inventory differs after cleanup'));
        console.log(JSON.stringify({ component: 'g6a-queues', before: [...before], owned, after: [...after] }));
      } catch (error) { failures.push(error); }
      finally {
        try { for (const value of clients) if (!destroyed.has(value)) value.destroy(); }
        finally { SQSClient.prototype.destroy = destroy; }
        console.log(JSON.stringify({ component: 'g6a-sqs-clients', created: clients.size, closed: destroyed.size }));
      }
      if (failures.length) throw new AggregateError(failures, 'G6A resource cleanup failed; STOP');
    },
  };
}
async function g6aSqsHarness() {
  const audit = await g6aQueueAudit();
  try { const sqs = await createSqsHarness(); return { ...sqs, audit, close: () => audit.close(() => sqs.close()) }; }
  catch (error) {
    try { await audit.close(async () => {}); } catch (cleanup) { throw new AggregateError([error, cleanup], 'G6A setup and cleanup failed'); }
    throw error;
  }
}
async function g6aOutboxHarness() {
  const audit = await g6aQueueAudit();
  try { const sqs = await createOutboxSqsHarness(); return { ...sqs, audit, close: () => audit.close(() => sqs.close()) }; }
  catch (error) {
    try { await audit.close(async () => {}); } catch (cleanup) { throw new AggregateError([error, cleanup], 'G6A setup and cleanup failed'); }
    throw error;
  }
}
async function g6aEmptyQueue(sqs: Awaited<ReturnType<typeof createSqsHarness>>, url: string) {
  const counts = await queueCounts(sqs, url);
  expect(counts['ApproximateNumberOfMessages']).toBe('0'); expect(counts['ApproximateNumberOfMessagesNotVisible']).toBe('0');
}

function g6aBuildGraph(kind: G6aGraph, metrics?: OperationalMetricsCollector) {
  const options = { metrics };
  if (kind === 'database') return DatabaseModule.forRoot(options);
  if (kind === 'consumer') return MessagingModule.forConsumer(options);
  if (kind === 'publisher') return MessagingModule.forPublisher(options);
  return WageringModule.forPendingReferences(options);
}
function g6aGraphLifecycle(app: INestApplicationContext, kind: Exclude<G6aGraph, 'database'>) {
  if (kind === 'consumer') return app.get(ConsumerLifecycle);
  if (kind === 'publisher') return app.get(PublisherLifecycle);
  return app.get(PendingReferenceLifecycle);
}
async function g6aConflictProbe(app: INestApplicationContext, barrier: ReturnType<typeof g6aInstallBarriers>) {
  const financial = inMemoryFinancial(); const error = new IdempotencyConflictError('G6A controlled identity probe');
  await barrier.probe({ failure: error }, async () => {
    await expect(app.get(ProcessWagerTransactionUseCase).execute(financial.input)).rejects.toBe(error);
  });
}
async function g6aProbeGraph(kind: G6aGraph, app: INestApplicationContext, collector: OperationalMetricsCollector,
  barrier: ReturnType<typeof g6aInstallBarriers>, sqs?: Awaited<ReturnType<typeof g6aSqsHarness>>,
  outbox?: Awaited<ReturnType<typeof g6aOutboxHarness>>) {
  if (kind === 'database') {
    await barrier.probe({ failure: { code: '23505', constraint: 'uq_wallet_player_currency' } }, async () => {
      await expect(app.get(CreateWalletUseCase).execute({ playerId: 'g6a-probe',
        initialBalance: { amount: '0.00', currency: 'BRL' }, correlationId })).rejects.toBeInstanceOf(ConflictError);
    });
    expect(collector.snapshot().concurrencyConflicts.byCode['23505']).toBe(1);
    await g6aConflictProbe(app, barrier);
    const h = inMemoryFinancial();
    await barrier.probe({ store: { getWallet: async () => h.wallet, ledgerTotal: async () => ({ amount: '90.00', count: 1 }) } }, async () => {
      expect((await app.get(ReconcileWalletUseCase).execute(h.wallet.id)).consistent).toBe(false);
    });
    expect(collector.snapshot().duplicates.conflicts).toBe(1); expect(collector.snapshot().processingDurationMs.count).toBe(1);
    expect(collector.snapshot().reconciliation.divergences).toBe(1);
    for (const token of [GetWalletUseCase, ListWalletLedgerUseCase, GetWagerTransactionUseCase]) {
      expect(Object.keys(app.get(token))).toEqual(['uow']);
    }
  } else if (kind === 'consumer') {
    if (!sqs) throw new Error('Missing G6A owned Consumer queues');
    // REV2-02 option (b): loop was drained before sending/receiving this message. Never race two consumers.
    await sqs.send('malformed-di-probe'); const message = await sqs.receiveSource();
    expect((await app.get(SqsWagerConsumer).handle(message)).action).toBe('dead-lettered');
    expect(collector.snapshot().dlq.confirmedTransfers).toBe(1); await g6aEmptyQueue(sqs, sqs.inputUrl);
    await g6aConflictProbe(app, barrier);
    expect(collector.snapshot().duplicates.conflicts).toBe(1); expect(collector.snapshot().processingDurationMs.count).toBe(1);
  } else if (kind === 'publisher') {
    if (!outbox) throw new Error('Missing G6A owned events queue');
    const eventId = randomUUID(); const aggregateId = randomUUID(); const occurredAt = new Date();
    const message = OutboxMessage.rehydrate({ id: eventId, aggregateId, eventType: 'WalletBalanceChanged', occurredAt, attempts: 0,
      nextAttemptAt: occurredAt, payload: { eventId, aggregateId, eventType: 'WalletBalanceChanged', occurredAt: occurredAt.toISOString(), data: {} } });
    let claimed = false; let confirmed = 0;
    await barrier.probe({ store: {
      claimNextOutbox: async (workerId, leaseToken, _now, leaseUntil) => {
        if (claimed) throw new Error('G6A probe was consumed twice'); claimed = true;
        return { message, workerId, leaseToken, leaseUntil };
      }, completeOutbox: async id => { expect(id).toBe(eventId); confirmed++; return true; },
    } }, async () => { expect((await app.get(OutboxPublisher).publishNext()).action).toBe('published'); });
    expect(claimed).toBe(true); expect(confirmed).toBe(1); expect(collector.snapshot().outboxLagMs.count).toBe(1);
    const messages = await g6aUntil(async () => { const values = await outbox.read(); return values.length ? values : undefined; });
    expect(messages).toHaveLength(1); expect(messages[0]?.payload['eventId']).toBe(eventId);
    expect(messages[0]?.groupId).toBe(aggregateId); expect(messages[0]?.dedupId).toBe(eventId);
  } else {
    const h = inMemoryFinancial(); const acceptedAt = new Date(Date.now() - 2000);
    const accepted = await new ProcessWagerTransactionUseCase(h.uow, { now: () => acceptedAt }).execute({ ...h.input,
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'g6a-absent-reference' });
    const pending = h.identities.find(tx => tx.id === accepted.transactionId)!;
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    let updates = 0;
    await barrier.probe({ store: {
      getWallet: async () => h.wallet, getWager: async id => id === pending.id ? pending : undefined,
      findWager: async () => undefined, updatePendingWager: async () => { updates++; return true; },
    } }, async () => {
      expect((await app.get(PendingReferenceWorker).resolve({ id: pending.id, walletId: h.wallet.id })).action).toBe('rescheduled');
    });
    expect(updates).toBe(1);
    expect(collector.snapshot()).toEqual({ ...g6aEmptySnapshot(), pendingReference: { processed: 0, rejected: 0, rescheduled: 1 } });
  }
}
async function g6aOneGraph(kind: G6aGraph, metrics?: OperationalMetricsCollector) {
  let sqs: Awaited<ReturnType<typeof g6aSqsHarness>> | undefined;
  let outbox: Awaited<ReturnType<typeof g6aOutboxHarness>> | undefined;
  const failures: unknown[] = []; let result: OperationalMetricsCollector | undefined;
  try {
    if (kind === 'consumer') sqs = await g6aSqsHarness();
    if (kind === 'publisher') outbox = await g6aOutboxHarness();
    const env: Record<string, string> = { WORKER_SHUTDOWN_TIMEOUT_MS: '5000' };
    if (kind === 'pending') Object.assign(env, { PENDING_REF_BASE_DELAY_MS: '1000', PENDING_REF_MAX_ATTEMPTS: '10', PENDING_REF_TTL_MS: '86400000' });
    if (sqs) Object.assign(env, { SQS_INPUT_QUEUE_NAME: sqs.inputName, SQS_DLQ_QUEUE_NAME: sqs.dlqName,
      SQS_MAX_RECEIVE_COUNT: '3', SQS_WAIT_SECONDS: '5' });
    if (outbox) env['SQS_EVENTS_QUEUE_NAME'] = outbox.name;
    await g6aWithTestEnv(env, async (url, absentEnv) => {
      const barrier = g6aInstallBarriers(url, absentEnv);
      let app: INestApplicationContext | undefined; let proof: MikroORM | undefined;
      try {
        // Pre-bootstrap, real read-only public inventory. This does not use createHarness or any migrator.
        proof = await MikroORM.init(databaseConfig(url));
        await g6aCheckPublic(proof);
        app = await NestFactory.createApplicationContext(g6aBuildGraph(kind, metrics), { logger: false, abortOnError: false });
        const actualOrm = app.get<MikroORM>(CoreORM);
        expect(barrier.createdOrms).toContain(actualOrm); expect(barrier.counters.init).toBe(2);
        expect(barrier.counters.verified).toBe(2); // Proof connection plus the real Nest provider.
        const collector = app.get<OperationalMetricsCollector>(OPERATIONAL_METRICS);
        expect(collector).toBeDefined(); expect(app.get<OperationalMetricsCollector>(OPERATIONAL_METRICS)).toBe(collector);
        if (metrics) expect(collector).toBe(metrics);
        expect(collector.snapshot()).toEqual(g6aEmptySnapshot());
        const modules = [...app.get(ModulesContainer).values()];
        expect(modules.filter(module => module.metatype === DatabaseModule)).toHaveLength(1);
        const providers = modules.flatMap(module => [...module.providers.entries()]).filter(([token]) => token === OPERATIONAL_METRICS);
        expect(providers).toHaveLength(1); expect<unknown>(providers[0]?.[1].instance).toBe(collector);
        if (kind !== 'database') await g6aGraphLifecycle(app, kind).beforeApplicationShutdown();
        if (kind === 'publisher') expect(barrier.counters.idleOutbox).toBeGreaterThan(0);
        if (kind === 'pending') expect(barrier.counters.idlePending).toBeGreaterThan(0);
        expect(collector.snapshot()).toEqual(g6aEmptySnapshot());
        await g6aProbeGraph(kind, app, collector, barrier, sqs, outbox);
        expect(barrier.counters.forbiddenSql).toBe(0); expect(barrier.counters.unexpectedStore).toBe(0);
        expect(barrier.counters.probes).toBeGreaterThan(0);
        result = collector;
      } catch (error) { failures.push(error); }
      finally {
        try {
          if (app) {
            if (kind === 'database') await app.close();
            else await closeWorkerApplication(app, g6aGraphLifecycle(app, kind));
          }
        } catch (error) { failures.push(error); }
        try { if (proof) await g6aCheckPublic(proof); } catch (error) { failures.push(error); }
        try { await barrier.close(); } catch (error) { failures.push(error); }
      }
    });
  } catch (error) { failures.push(error); }
  finally {
    try { await sqs?.close(); } catch (error) { failures.push(error); }
    try { await outbox?.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'G6A graph or cleanup failed; next graph is blocked');
  if (!result) throw new Error('G6A graph did not provide a collector');
  return result;
}
function g6aAssertIndependent(first: OperationalMetricsCollector, second: OperationalMetricsCollector,
  retained: ReturnType<OperationalMetricsCollector['snapshot']>) {
  expect(second).not.toBe(first); expect(first.snapshot()).toEqual(retained);
}
async function g6aGraphSequence(kind: G6aGraph): Promise<void> {
  // REV2-02: never keep two contexts alive. Only collector1 and its immutable snapshot survive closure.
  const first = await g6aOneGraph(kind); const retained = first.snapshot();
  const second = await g6aOneGraph(kind); g6aAssertIndependent(first, second, retained);
  const explicit = new DefaultOperationalMetricsCollector();
  expect(await g6aOneGraph(kind, explicit)).toBe(explicit);
  expect(first.snapshot()).toEqual(retained);
}

// Inline child definitions share the exact guarded ORM code; no test module is imported into a child.
// Their construction is inert. E1 validates syntax statically and never invokes Bun.spawn.
function g6aBootstrapChild(mode: 'partial' | 'mismatch'): string {
  const definitions = [g6aTarget, g6aCheckEnv, g6aValidateIdentity, g6aCheckPublic, g6aRestrictedStore,
    g6aAuditSql, g6aInstallBarriers].map(fn => fn.toString()).join('\n');
  return `import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { SQSClient,ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { DatabaseModule } from './src/database/database.module';
import { MessagingModule } from './src/modules/messaging/messaging.module';
import { PostgresUnitOfWork } from './src/database/postgres-unit-of-work';
import { databaseConfig } from './src/database/config';
import { ConsumerLifecycle } from './src/modules/messaging/infrastructure/consumer-lifecycle';
import { closeWorkerApplication } from './src/shared/application/worker-signals';
const g6aIdentitySql=${JSON.stringify(g6aIdentitySql)};
const g6aPublicSql=${JSON.stringify(g6aPublicSql)};
${definitions}
const url=g6aTarget(process.env.TEST_DATABASE_URL);
const absent=process.env.MIKRO_ORM_ENV;
g6aCheckEnv(url,absent);
const up=Migrator.prototype.up;
Migrator.prototype.up=async()=>{throw new Error('G6A child forbids migrations')};
const barrier=g6aInstallBarriers(url,absent);
const send=SQSClient.prototype.send,destroy=SQSClient.prototype.destroy;
const clients=new Set(),closed=new Set();let receives=0,app,proof,expected=false,failed=false;
SQSClient.prototype.send=function(command,...args){clients.add(this);if(command instanceof ReceiveMessageCommand)receives++;return Reflect.apply(send,this,[command,...args])};
SQSClient.prototype.destroy=function(){closed.add(this);return destroy.call(this)};
try{
 proof=await MikroORM.init(databaseConfig(url));await g6aCheckPublic(proof);
 class PartialRoot{};Module({})(PartialRoot);
 const descriptor=${JSON.stringify(mode)}==='partial'?{module:PartialRoot,imports:[DatabaseModule.forRoot()],providers:[{
 provide:'G6A_EXPECTED_PARTIAL',inject:[CoreORM],useFactory:()=>{throw new Error('G6A_EXPECTED_PARTIAL')}
 }]}:MessagingModule.forConsumer();
 try{app=await NestFactory.createApplicationContext(descriptor,{logger:false,abortOnError:false})}
 catch(error){const message=error instanceof Error?error.message:'';
 expected=${JSON.stringify(mode)}==='partial'?message.includes('G6A_EXPECTED_PARTIAL'):message.includes('redrive policy/config mismatch');
 if(!expected)throw new Error('G6A unexpected bootstrap failure');}
 if(!expected||app||barrier.createdOrms.length<2||receives!==0)throw new Error('G6A negative bootstrap did not reach its intended boundary');
}catch{failed=true}
finally{
 try{if(app)await closeWorkerApplication(app,app.get(ConsumerLifecycle))}catch{failed=true}
 try{if(proof)await g6aCheckPublic(proof)}catch{failed=true}
 try{await barrier.close()}catch{failed=true}
 try{for(const client of clients)if(!closed.has(client))client.destroy()}catch{failed=true}
 SQSClient.prototype.send=send;SQSClient.prototype.destroy=destroy;Migrator.prototype.up=up;
 console.log(JSON.stringify({component:'g6a-child',expected,failed,orms:barrier.createdOrms.length,clients:clients.size,closed:closed.size,receives}));
}
process.exitCode=failed?1:0;`;
}
function g6aChildReport(stdout: string) {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.trim().split('\n')) {
    try { const value: unknown = JSON.parse(line); if (value && typeof value === 'object') records.push(value as Record<string, unknown>); }
    catch { throw new Error('G6A child emitted an invalid audit record'); }
  }
  const report = records.find(record => record['component'] === 'g6a-child');
  if (!report) throw new Error('Missing G6A child cleanup evidence');
  for (const record of records) if (record['component'] === 'g6a-audit') console.log(JSON.stringify({ ...record, component: 'g6a-child-audit' }));
  return report;
}

g6aTest('G6A-X01 NO_MIGRATION rejects unsafe destinations and environment overrides before bootstrap', async () => {
  for (const value of ['postgresql://localhost:5433/jungle_dev', 'postgresql://localhost:5434/jungle_dev',
    'postgresql://remote.invalid:5434/jungle_test', 'postgresql://localhost:5434/jungle_test?options=unsafe',
    'postgresql://localhost:5434/jungle_test#unsafe', 'postgresql://localhost:5432/jungle_test']) {
    expect(() => g6aTarget(value)).toThrow();
  }
  let reached = false;
  await expect(g6aWithTestEnv({ MIKRO_ORM_CLIENT_URL: 'postgresql://localhost:5433/jungle_dev' }, async () => { reached = true; })).rejects.toThrow();
  expect(reached).toBe(false); expect(process.env['MIKRO_ORM_CLIENT_URL']).toBeUndefined();
});
g6aTest('G6A-X02 NO_MIGRATION rejects nonempty public or unsafe identity and privileges without DDL', async () => {
  const valid: G6aIdentity = { db: 'jungle_test', schema: 'public', search_path: 'public,public', version: '160006',
    read_only: 'on', role: 'jungle_test', can_connect: true, can_use_public: true };
  expect(() => g6aValidateIdentity(valid, [])).not.toThrow();
  expect(() => g6aValidateIdentity(valid, [{ relname: 'wallets', relkind: 'r' }])).toThrow();
  for (const override of [{ db: 'jungle_dev' }, { schema: 'unsafe' }, { search_path: 'public,other' },
    { version: '150000' }, { read_only: 'off' }, { can_connect: false }, { can_use_public: false }]) {
    expect(() => g6aValidateIdentity({ ...valid, ...override }, [])).toThrow();
  }
});
g6aTest('G6A-X03 NO_MIGRATION rejects preexisting queues and intentional redrive mismatch 5 versus 3', async () => {
  const queue = { name: `jungle_it_${randomUUID().replaceAll('-', '')}_input.fifo`, url: 'http://127.0.0.1:4566/preexisting' };
  expect(() => g6aOwnQueue(queue, new Set([queue.url]))).toThrow();
  expect(() => g6aOwnQueue({ ...queue, name: 'wager-transactions.fifo' }, new Set())).toThrow();
  const sqs = await g6aSqsHarness();
  try {
    await g6aWithTestEnv({ SQS_INPUT_QUEUE_NAME: sqs.inputName, SQS_DLQ_QUEUE_NAME: sqs.dlqName,
      SQS_MAX_RECEIVE_COUNT: '5', SQS_WAIT_SECONDS: '5', WORKER_SHUTDOWN_TIMEOUT_MS: '5000' }, async () => {
      const child = await g6aChild(g6aBootstrapChild('mismatch'), 20000);
      expect(child.exitCode).toBe(0); expect(child.stderr).toBe('');
      const report = g6aChildReport(child.stdout);
      expect(report['expected']).toBe(true); expect(report['failed']).toBe(false); expect(report['receives']).toBe(0);
      expect(report['clients']).toBe(report['closed']);
    });
  } finally { await sqs.close(); }
});
g6aTest('G6A-X04 NO_MIGRATION partial bootstrap is isolated in a joined child and closes registered ORMs', async () => {
  const child = await g6aChild(g6aBootstrapChild('partial'), 20000);
  expect(child.exitCode).toBe(0); expect(child.stderr).toBe('');
  const report = g6aChildReport(child.stdout);
  expect(report['expected']).toBe(true); expect(report['failed']).toBe(false); expect(Number(report['orms'])).toBeGreaterThanOrEqual(2);
  expect(report['clients']).toBe(report['closed']);
});
g6aTest('G6A-X05 NO_MIGRATION incomplete shutdown triggers the real watchdog only inside its child', async () => {
  const source = `import {WorkerShutdown} from './src/shared/application/worker-shutdown';
const control=new WorkerShutdown('g6a-negative',{timeoutMs:50});
control.start(async()=>new Promise(()=>{}));await control.drain();`;
  const child = await g6aChild(source, 3000);
  expect(child.exitCode).toBe(1);
  const records = child.stdout.trim().split('\n').map(line => JSON.parse(line) as { phase: string });
  expect(records.map(record => record.phase)).toEqual(['drain-started', 'timeout']);
});
g6aTest('G6A-X06 NO_MIGRATION missing HTTP protocol hits deadline and its child is killed and joined', async () => {
  await expect(g6aChild('setInterval(()=>{},1000);', 250)).rejects.toThrow('G6A child deadline exceeded');
  const incomplete = await g6aChild("console.log(JSON.stringify({type:'ready'}));", 3000);
  expect(incomplete.exitCode).toBe(0);
  const frames = incomplete.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string });
  expect(() => { expect(frames.map(frame => frame.type)).toEqual(['ready', 'result', 'done']); }).toThrow();
});
g6aTest('G6A-X07 NO_MIGRATION partial cleanup is aggregated while every owned queue is removed independently', async () => {
  const sqs = await g6aSqsHarness();
  try {
    await expect(sqs.audit.close(async () => { throw new Error('synthetic first cleanup failure'); })).rejects.toBeInstanceOf(AggregateError);
    // Independent read-back prevents an arbitrary cleanup rejection from being mistaken for a passing negative.
    const client = localSqsClient();
    try {
      const after = await g6aQueues(client);
      for (const url of sqs.audit.before) expect(after.has(url)).toBe(true);
      for (const queue of sqs.audit.owned) expect(after.has(queue.url)).toBe(false);
    } finally { client.destroy(); }
  } finally { await sqs.close(); }
});
g6aTest('G6A-X08 NO_MIGRATION shared default collector fails strict graph identity', async () => {
  const first = new DefaultOperationalMetricsCollector(); const second = new DefaultOperationalMetricsCollector();
  const retained = first.snapshot();
  expect(() => g6aAssertIndependent(first, first, retained)).toThrow();
  expect(() => g6aAssertIndependent(first, second, retained)).not.toThrow();
});
g6aTest('G6A-X09 NO_MIGRATION migrations and non-audit SQL are rejected before any execution', async () => {
  await expect(Migrator.prototype.up.call(Object.create(Migrator.prototype))).rejects.toThrow('G6A prohibits Migrator.up');
  for (const sql of ['create schema unsafe', 'create table unsafe(id int)', 'drop table wallets',
    'update outbox_messages set attempts=1', 'select * from wallets', 'begin', 'set transaction read write']) {
    expect(() => g6aAuditSql(sql)).toThrow();
  }
  expect(() => g6aAuditSql(g6aIdentitySql)).not.toThrow(); expect(() => g6aAuditSql(g6aPublicSql)).not.toThrow();
});
