import 'reflect-metadata';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { NestFactory, ModulesContainer } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { AppModule } from '../../src/app.module';
import { DatabaseModule } from '../../src/database/database.module';
import { WalletsModule } from '../../src/modules/wallets/wallets.module';
import { WageringModule } from '../../src/modules/wagering/wagering.module';
import { WalletsController } from '../../src/modules/wallets/infrastructure/wallets.controller';
import { WageringController } from '../../src/modules/wagering/infrastructure/wagering.controller';
import { FINANCIAL_UNIT_OF_WORK, type FinancialStore, type FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import { ProcessWagerTransactionUseCase, type ProcessWagerInput, type ProcessWagerResult } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode as F } from '../../src/modules/wagering/domain/failure-code';
import { Money } from '../../src/shared/domain/money';
import { wagerPayloadHash } from '../../src/modules/wagering/application/wager-payload';
import { SqsWagerConsumer } from '../../src/modules/messaging/application/sqs-wager-consumer';
import { SystemClock } from '../../src/shared/application/clock';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { createHarness, request, type Harness } from '../support/postgres';
import { createSqsHarness, type SqsHarness } from '../support/sqs';

let h: Harness;
let app: INestApplication;
let sqs: SqsHarness | undefined;
async function start(uow: FinancialUnitOfWork) {
  const application = await NestFactory.create(AppModule.register({ uow }), { logger: false, abortOnError: false });
  try { await application.listen(0, '127.0.0.1'); return application; }
  catch (error) { await application.close(); throw error; }
}
beforeEach(async () => {
  h = await createHarness();
  try { app = await start(h.uow); } catch (error) { await h.close(); throw error; }
}, 20000);
afterEach(async () => {
  try {
    if (h) {
      const mismatches = await h.orm.em.fork().execute(`select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id=w.id
        group by w.id having w.balance <> coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0)`);
      expect(mismatches).toEqual([]);
    }
  } finally {
    try { await app?.close(); } finally {
      try { await sqs?.close(); } finally { sqs = undefined; if (h) await h.close(); }
    }
  }
}, 15000);
function body(input: ProcessWagerInput) {
  const { idempotencyKey: _key, correlationId: _correlation, causationId: _cause, inbox: _inbox, ...payload } = input;
  return payload;
}
async function post(input: ProcessWagerInput, application = app) {
  const response = await fetch(`${await application.getUrl()}/wagering/transactions`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey, 'x-correlation-id': 'untrusted' }, body: JSON.stringify(body(input)) });
  return { response, result: await response.json() as ProcessWagerResult };
}
async function counts(walletId: string) {
  const [row] = await h.orm.em.fork().execute<{ ledger: string; wagers: string; outbox: string; inbox: string }[]>(`select
    (select count(*)::text from wallet_ledger_entries where wallet_id=?) as ledger,
    (select count(*)::text from wager_transactions where wallet_id=?) as wagers,
    (select count(*)::text from outbox_messages where aggregate_id=?) as outbox,
    (select count(*)::text from inbox_messages) as inbox`, [walletId, walletId, walletId]);
  return row!;
}
async function balance(walletId: string, expected: string) {
  expect((await h.get.execute(walletId)).balance.toString()).toBe(expected);
  expect((await h.reconcile.execute(walletId)).consistent).toBe(true);
}
async function queues() { return sqs ??= await createSqsHarness(); }
async function delivery(input: ProcessWagerInput, process = h.process) {
  const q = await queues();
  const envelope = { type: 'WagerTransactionRequested', messageId: crypto.randomUUID(), occurredAt: new Date().toISOString(), correlationId: input.correlationId,
    data: { ...body(input), idempotencyKey: input.idempotencyKey } };
  await q.send(JSON.stringify(envelope));
  const message = await q.receiveSource();
  return { messageId: envelope.messageId, message,
    handle: () => new SqsWagerConsumer(process, q.transport, new SystemClock(), q.config, () => {}).handle(message) };
}
async function assertInbox(messageId: string) {
  const rows = await h.orm.em.fork().execute<{ processed: boolean }[]>('select processed_at is not null as processed from inbox_messages where message_id=?', [messageId]);
  expect(rows).toEqual([{ processed: true }]);
}

test('T01 BET returns exact 200 result, one debit and correlated events from the shared use case', async () => {
  const wallet = await h.wallet(); const input = request(wallet);
  const { response, result } = await post(input);
  expect(response.status).toBe(200);
  expect(result).toEqual({ transactionId: result.transactionId, status: S.Processed, balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false });
  expect(await counts(wallet.id)).toEqual({ ledger: '2', wagers: '2', outbox: '4', inbox: '0' });
  const events = await h.orm.em.fork().execute<{ correlation: string }[]>(`select payload->>'correlationId' as correlation from outbox_messages where payload->'data'->>'transactionId'=?`, [result.transactionId]);
  expect(events).toHaveLength(2);
  expect(events.every(e => e.correlation === response.headers.get('x-correlation-id'))).toBe(true);
  await balance(wallet.id, '90.00');
});
for (const [kind, amount, expected, ledger] of [[K.Loss, '0.00', '100.00', '1'], [K.Win, '25.00', '125.00', '2']] as const) {
  test(`T02/T03 ${kind} preserves its financial effect and HTTP 200`, async () => {
    const wallet = await h.wallet();
    const { response, result } = await post(request(wallet, { kind, money: { amount, currency: 'BRL' } }));
    expect(response.status).toBe(200); expect(result.status).toBe(S.Processed);
    expect((await counts(wallet.id)).ledger).toBe(ledger);
    await balance(wallet.id, expected);
  });
}
test('T04 insufficient BET is persisted REJECTED with 422 and replay preserves rejection snapshot', async () => {
  const wallet = await h.wallet(); const input = request(wallet, { money: { amount: '200.00', currency: 'BRL' } });
  const first = await post(input);
  expect(first.response.status).toBe(422); expect(first.result.failureCode).toBe(F.InsufficientFundsBet);
  expect(first.result.status).toBe(S.Rejected);
  expect((await counts(wallet.id)).ledger).toBe('1');
  await h.process.execute(request(wallet, { kind: K.Win, money: { amount: '500.00', currency: 'BRL' } }));
  const before = await counts(wallet.id); const replay = await post(input);
  expect(replay.response.status).toBe(422); expect(replay.result).toEqual({ ...first.result, idempotentReplay: true });
  expect(await counts(wallet.id)).toEqual(before); await balance(wallet.id, '600.00');
});
for (const kind of [K.Refund, K.Rollback]) {
  test(`T05/T06 ${kind} reverses one BET and replay does not duplicate credit`, async () => {
    const wallet = await h.wallet(); const bet = request(wallet);
    await post(bet);
    const input = request(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId });
    const first = await post(input);
    expect(first.response.status).toBe(200); expect(first.result.balance.amount).toBe('100.00');
    const before = await counts(wallet.id);
    expect((await post(input)).result).toEqual({ ...first.result, idempotentReplay: true });
    expect(await counts(wallet.id)).toEqual(before);
    expect(before.ledger).toBe('3'); await balance(wallet.id, '100.00');
  });
}
test('T08 incompatible reference is financial 422 without another movement', async () => {
  const wallet = await h.wallet(); const win = request(wallet, { kind: K.Win }); await post(win);
  const rejected = await post(request(wallet, { kind: K.Refund, referenceExternalTransactionId: win.externalTransactionId }));
  expect(rejected.response.status).toBe(422); expect(rejected.result.failureCode).toBe(F.ReferenceInvalidKind);
  expect((await counts(wallet.id)).ledger).toBe('2'); await balance(wallet.id, '110.00');
});
test('T11/T18 historical PROCESSED snapshot survives later balance movement and conflicting identities add no effects', async () => {
  const wallet = await h.wallet(); const input = request(wallet);
  const first = await post(input);
  await post(request(wallet, { kind: K.Win, money: { amount: '50.00', currency: 'BRL' } }));
  const before = await counts(wallet.id);
  const replay = await post(input);
  expect(replay.response.status).toBe(200); expect(replay.result).toEqual({ ...first.result, idempotentReplay: true });
  for (const conflict of [{ ...input, money: { amount: '20.00', currency: 'BRL' } }, { ...input, idempotencyKey: 'different-key' }, { ...input, walletId: crypto.randomUUID() }]) {
    expect((await post(conflict)).response.status).toBe(409);
  }
  expect(await counts(wallet.id)).toEqual(before); await balance(wallet.id, '140.00');
});
test('missing wallet is 404; valid currency mismatch is persisted 422 while invalid ISO is 400 without persistence', async () => {
  const wallet = await h.wallet(); const before = await counts(wallet.id);
  expect((await post(request(wallet, { walletId: crypto.randomUUID() }))).response.status).toBe(404);
  expect((await post(request(wallet, { money: { amount: '1.00', currency: 'ZZZ' } }))).response.status).toBe(400);
  expect(await counts(wallet.id)).toEqual(before);
  const mismatch = await post(request(wallet, { money: { amount: '1.00', currency: 'USD' } }));
  expect(mismatch.response.status).toBe(422);
  expect(mismatch.result).toEqual({ transactionId: mismatch.result.transactionId, status: S.Rejected, failureCode: F.CurrencyMismatch,
    balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: false });
  const rows = await h.orm.em.fork().execute<{ currency: string; recorded_balance_currency: string }[]>('select currency, recorded_balance_currency from wager_transactions where id=?', [mismatch.result.transactionId]);
  expect(rows).toEqual([{ currency: 'USD', recorded_balance_currency: 'BRL' }]);
  expect((await counts(wallet.id)).ledger).toBe('1'); await balance(wallet.id, '100.00');
});
test('T16 fifty concurrent POSTs produce one original, 49 replays and a single debit/event bundle', async () => {
  const wallet = await h.wallet(); const input = request(wallet);
  const results = await Promise.all(Array.from({ length: 50 }, () => post(input)));
  expect(results.every(r => r.response.status === 200 && r.result.balance.amount === '90.00')).toBe(true);
  expect(results.filter(r => !r.result.idempotentReplay)).toHaveLength(1);
  expect(results.filter(r => r.result.idempotentReplay)).toHaveLength(49);
  expect(new Set(results.map(r => r.result.transactionId)).size).toBe(1);
  expect(await counts(wallet.id)).toEqual({ ledger: '2', wagers: '2', outbox: '4', inbox: '0' }); await balance(wallet.id, '90.00');
}, 15000);
test('T17 concurrent BETs of 80 over balance 100 have one 200, one 422, balance 20', async () => {
  const wallet = await h.wallet();
  const results = await Promise.all([post(request(wallet, { money: { amount: '80.00', currency: 'BRL' } })), post(request(wallet, { money: { amount: '80.00', currency: 'BRL' } }))]);
  expect(results.map(r => r.response.status).sort()).toEqual([200, 422]);
  expect((await counts(wallet.id)).ledger).toBe('2'); await balance(wallet.id, '20.00');
});
test('T23 historical terminal FAILED returns exact 422 snapshot and remains immutable without new events', async () => {
  const wallet = await h.wallet(); const input = request(wallet);
  const failed = WagerTransaction.create({ ...input, id: crypto.randomUUID(), payloadHash: wagerPayloadHash(input), money: Money.from(input.money), createdAt: new Date() });
  failed.fail(F.InfrastructurePermanent, wallet.balance);
  await h.uow.run(store => store.insertWager(failed));
  await h.process.execute(request(wallet, { kind: K.Win, money: { amount: '25.00', currency: 'BRL' } }));
  const before = await counts(wallet.id);
  const rowsBefore = await h.orm.em.fork().execute('select * from wager_transactions where id=?', [failed.id]);
  for (let n = 0; n < 2; n++) {
    const result = await post(input);
    expect(result.response.status).toBe(422);
    expect(result.result).toEqual({ transactionId: failed.id, status: S.Failed, failureCode: F.InfrastructurePermanent, balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: true });
  }
  expect(await counts(wallet.id)).toEqual(before);
  expect(await h.orm.em.fork().execute('select * from wager_transactions where id=?', [failed.id])).toEqual(rowsBefore);
  await balance(wallet.id, '125.00');
});
test('T07/T25 PENDING_REFERENCE replays acceptance snapshot then terminal resolution snapshot', async () => {
  const wallet = await h.wallet(); const bet = request(wallet);
  const input = request(wallet, { kind: K.Refund, referenceExternalTransactionId: bet.externalTransactionId });
  const accepted = await post(input);
  expect(accepted.response.status).toBe(202); expect(accepted.result.balance.amount).toBe('100.00');
  await post(request(wallet, { kind: K.Win, money: { amount: '50.00', currency: 'BRL' } }));
  const before = await counts(wallet.id);
  const pendingReplay = await post(input);
  expect(pendingReplay.response.status).toBe(202); expect(pendingReplay.result).toEqual({ ...accepted.result, idempotentReplay: true });
  expect(await counts(wallet.id)).toEqual(before);
  await post(bet);
  const pending = await h.uow.run(store => store.getWager(accepted.result.transactionId));
  expect(pending?.nextRetryAt).toBeDefined();
  const clock = { now: () => new Date(pending!.nextRetryAt!.getTime()) };
  const worker = new PendingReferenceWorker(h.uow, clock);
  expect(await worker.resolve({ id: accepted.result.transactionId, walletId: wallet.id })).toEqual({ transactionId: accepted.result.transactionId, action: 'processed' });
  const resolvedCounts = await counts(wallet.id);
  const resolved = await post(input);
  expect(resolved.response.status).toBe(200);
  expect(resolved.result).toEqual({ transactionId: accepted.result.transactionId, status: S.Processed, balance: { amount: '150.00', currency: 'BRL' }, idempotentReplay: true });
  expect(await counts(wallet.id)).toEqual(resolvedCounts); await balance(wallet.id, '150.00');
});

for (const first of ['http', 'sqs'] as const) {
  test(`T14/T15 ${first} first and the other channel replays with completed Inbox and identical stored hash`, async () => {
    const wallet = await h.wallet(); const input = request(wallet);
    const delivered = await delivery(input);
    let http: Awaited<ReturnType<typeof post>>;
    let outcome: Awaited<ReturnType<typeof delivered.handle>>;
    if (first === 'http') { http = await post(input); outcome = await delivered.handle(); }
    else { outcome = await delivered.handle(); http = await post(input); }
    expect(http.response.status).toBe(200); expect(outcome.action).toBe('acked');
    if (outcome.action !== 'acked') throw new Error('Expected confirmed SQS result');
    expect(http.result.idempotentReplay).toBe(first === 'sqs'); expect(outcome.result.idempotentReplay).toBe(first === 'http');
    expect(http.result.transactionId).toBe(outcome.result.transactionId);
    const stored = await h.uow.run(store => store.getWager(http.result.transactionId));
    expect(stored?.payloadHash).toBe(wagerPayloadHash(input));
    await assertInbox(delivered.messageId);
    expect(await counts(wallet.id)).toEqual({ ledger: '2', wagers: '2', outbox: '4', inbox: '1' }); await balance(wallet.id, '90.00');
  });
  for (const mode of ['payload', 'external-id', 'wallet'] as const) {
    test(`cross-channel ${mode} conflict after ${first} wins never creates a second financial effect`, async () => {
      const wallet = await h.wallet(); const other = await h.wallet(); const input = request(wallet);
      const conflict = mode === 'payload' ? { ...input, money: { amount: '20.00', currency: 'BRL' } }
        : mode === 'external-id' ? { ...input, idempotencyKey: 'another-key' } : { ...input, walletId: other.id, playerId: other.playerId };
      if (first === 'http') {
        expect((await post(input)).response.status).toBe(200);
        const delivered = await delivery(conflict);
        expect(await delivered.handle()).toEqual({ action: 'dead-lettered', code: 'IDEMPOTENCY_CONFLICT' });
        expect((await counts(wallet.id)).inbox).toBe('0');
      } else {
        const delivered = await delivery(input); expect((await delivered.handle()).action).toBe('acked');
        await assertInbox(delivered.messageId);
        expect((await post(conflict)).response.status).toBe(409);
      }
      expect((await counts(wallet.id)).ledger).toBe('2'); expect((await counts(wallet.id)).outbox).toBe('4');
      expect((await counts(other.id)).ledger).toBe('1'); expect((await counts(other.id)).outbox).toBe('2');
      await balance(wallet.id, '90.00'); await balance(other.id, '100.00');
    });
  }
}

function simultaneousUow() {
  let arrivals = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const timer = setTimeout(release, 3000);
  const uow: FinancialUnitOfWork = { run: work => h.uow.run(store => work(new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (key === 'getWallet' && args[1] === true) { if (++arrivals === 2) release(); await gate; }
        return value.apply(target, args);
      };
    },
  }) as FinancialStore)) };
  return { uow, done() { clearTimeout(timer); release(); expect(arrivals).toBeGreaterThanOrEqual(2); } };
}
for (const different of [false, true]) {
  test(`T24 HTTP/SQS overlap in real SQL transactions; divergent payload=${different}`, async () => {
    const wallet = await h.wallet(); const input = request(wallet); const barrier = simultaneousUow();
    const concurrentApp = await start(barrier.uow);
    try {
      const incoming = different ? { ...input, money: { amount: '20.00', currency: 'BRL' } } : input;
      const delivered = await delivery(incoming, new ProcessWagerTransactionUseCase(barrier.uow));
      const [http, outcome] = await Promise.all([post(input, concurrentApp), delivered.handle()]);
      if (!different) {
        expect(http.response.status).toBe(200); expect(outcome.action).toBe('acked');
        if (outcome.action !== 'acked') throw new Error('Expected replay');
        expect([http.result.idempotentReplay, outcome.result.idempotentReplay].sort()).toEqual([false, true]);
        expect(http.result.transactionId).toBe(outcome.result.transactionId); await assertInbox(delivered.messageId);
        await balance(wallet.id, '90.00');
      } else if (http.response.status === 409) {
        expect(outcome.action).toBe('acked'); await assertInbox(delivered.messageId); await balance(wallet.id, '80.00');
      } else {
        expect(http.response.status).toBe(200); expect(outcome).toEqual({ action: 'dead-lettered', code: 'IDEMPOTENCY_CONFLICT' });
        expect((await counts(wallet.id)).inbox).toBe('0'); await balance(wallet.id, '90.00');
      }
      expect((await counts(wallet.id)).ledger).toBe('2'); expect((await counts(wallet.id)).wagers).toBe('2'); expect((await counts(wallet.id)).outbox).toBe('4');
    } finally { try { barrier.done(); } finally { await concurrentApp.close(); } }
  }, 15000);
}

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(`T19 failure ${phase} gives sanitized 500 and retry recovers exactly one financial effect`, async () => {
    const wallet = await h.wallet(); const input = request(wallet); let armed = true;
    const uow: FinancialUnitOfWork = { async run(work, isolation) {
      const result = await h.uow.run(async store => {
        const value = await work(store);
        if (armed && phase === 'before-commit') { armed = false; throw new Error('injected SQL details'); }
        return value;
      }, isolation);
      if (armed && phase === 'after-commit') { armed = false; throw new Error('lost commit confirmation'); }
      return result;
    } };
    const failing = await start(uow);
    try {
      const before = await counts(wallet.id);
      const lost = await post(input, failing);
      expect(lost.response.status).toBe(500);
      expect(lost.result as unknown).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
      if (phase === 'before-commit') expect(await counts(wallet.id)).toEqual(before);
      const retry = await post(input, failing);
      expect(retry.response.status).toBe(200); expect(retry.result.idempotentReplay).toBe(phase === 'after-commit');
      expect(await counts(wallet.id)).toEqual({ ledger: '2', wagers: '2', outbox: '4', inbox: '0' });
      await balance(wallet.id, '90.00');
    } finally { await failing.close(); }
  });
}
test('real PostgreSQL transient exhausts bounded retry as HTTP 503 with no committed wager and succeeds after recovery', async () => {
  const wallet = await h.wallet(); const input = request(wallet); const before = await counts(wallet.id);
  await h.orm.em.fork().execute(`create function cp02_http_transient() returns trigger as $$ begin
    if NEW.kind='BET' then raise exception 'injected transient' using errcode='40P01'; end if; return NEW; end; $$ language plpgsql;
    create trigger cp02_http_transient before insert on wager_transactions for each row execute function cp02_http_transient()`);
  const failed = await post(input);
  expect(failed.response.status).toBe(503); expect(failed.result as unknown).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' });
  expect(await counts(wallet.id)).toEqual(before);
  await h.orm.em.fork().execute('drop trigger cp02_http_transient on wager_transactions; drop function cp02_http_transient()');
  expect((await post(input)).response.status).toBe(200); await balance(wallet.id, '90.00');
});

test('T21 injected HTTP graph shares one database/UoW and central filter/correlation across both controllers', async () => {
  expect(await h.orm.em.getConnection().execute<{ version: string }[]>("select current_setting('server_version_num') as version")).toEqual([{ version: '160006' }]);
  const modules = [...app.get(ModulesContainer).values()];
  const database = modules.filter(m => m.metatype === DatabaseModule);
  expect(database).toHaveLength(1);
  for (const moduleType of [WalletsModule, WageringModule]) {
    const feature = modules.find(m => m.metatype === moduleType)!;
    expect([...feature.imports].filter(m => m.metatype === DatabaseModule)).toEqual(database);
  }
  expect(app.get<FinancialUnitOfWork>(FINANCIAL_UNIT_OF_WORK)).toBe(h.uow);
  expect(app.get(WalletsController)).toBeInstanceOf(WalletsController); expect(app.get(WageringController)).toBeInstanceOf(WageringController);
  expect(modules.flatMap(m => [...m.providers.keys()]).filter(token => token === CoreORM)).toHaveLength(0);
  expect(modules.flatMap(m => [...m.providers.values()]).filter(p => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(p.metatype?.name ?? ''))).toHaveLength(0);
  expect(modules.flatMap(m => [...m.providers.values()]).filter(p => p.metatype?.name === 'HttpExceptionFilter')).toHaveLength(1);
  const response = await fetch(`${await app.getUrl()}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 'player-http-shared', initialBalance: { amount: '100.00', currency: 'BRL' } }) });
  expect(response.status).toBe(201);
  const wallet = await response.json() as { id: string; playerId: string };
  const wager = await post(request(wallet));
  expect(wager.response.status).toBe(200);
  expect(wager.response.headers.get('x-correlation-id')).not.toBe(response.headers.get('x-correlation-id'));
  expect((await fetch(`${await app.getUrl()}/wallets/${wallet.id}`)).status).toBe(200);
  for (const path of ['/wallets', '/wagering/transactions']) {
    const malformed = await fetch(`${await app.getUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ code: 'BAD_REQUEST', message: 'Bad request' });
    expect(malformed.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
  }
});
test('T21 production graph initializes one real ORM/pool, shares it with both features and closes it', async () => {
  const previous = process.env['DATABASE_URL']; process.env['DATABASE_URL'] = h.url;
  const initialize = MikroORM.init.bind(MikroORM);
  const init = spyOn(MikroORM, 'init').mockImplementation((async (options: Parameters<typeof MikroORM.init>[0]) => {
    if (!options || options.clientUrl !== h.url) throw new Error('Unexpected HTTP test database');
    return initialize({ ...options, schema: h.schema, driverOptions: { ...options.driverOptions, connection: { ...options.driverOptions?.connection, options: `-c search_path=${h.schema}` } } });
  }) as typeof MikroORM.init);
  let production: INestApplication | undefined; let owned: MikroORM | undefined;
  try {
    production = await NestFactory.create(AppModule, { logger: false, abortOnError: false }); await production.listen(0, '127.0.0.1');
    const modules = [...production.get(ModulesContainer).values()];
    expect(init).toHaveBeenCalledTimes(1); expect(modules.filter(m => m.metatype === DatabaseModule)).toHaveLength(1);
    expect(modules.flatMap(m => [...m.providers.entries()]).filter(([token]) => token === CoreORM)).toHaveLength(1);
    owned = production.get<MikroORM>(CoreORM);
    expect(owned.config.get('replicas') ?? []).toHaveLength(0); expect(owned.em.getConnection().getKnex().client.pool).toBeDefined();
    expect(await owned.em.getConnection().execute<{ database: string; schema: string }[]>('select current_database() as database,current_schema() as schema')).toEqual([{ database: 'jungle_test', schema: h.schema }]);
    expect(modules.flatMap(m => [...m.providers.values()]).filter(p => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(p.metatype?.name ?? ''))).toHaveLength(0);
    const response = await fetch(`${await production.getUrl()}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 'production-shared-test', initialBalance: { amount: '100.00', currency: 'BRL' } }) });
    expect(response.status).toBe(201); const wallet = await response.json() as { id: string; playerId: string };
    const wager = await post(request(wallet), production); expect(wager.response.status).toBe(200);
    expect(wager.response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect((await post(request(wallet, { money: { amount: '1.00', currency: 'ZZZ' } }), production)).response.status).toBe(400);
  } finally {
    await production?.close(); init.mockRestore();
    if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous;
  }
  expect(await owned?.isConnected()).toBe(false); expect(await h.orm.isConnected()).toBe(true);
});
