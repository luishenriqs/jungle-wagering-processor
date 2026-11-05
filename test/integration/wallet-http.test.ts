import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { NestFactory, ModulesContainer } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { AppModule } from '../../src/app.module';
import { DatabaseModule } from '../../src/database/database.module';
import { FINANCIAL_UNIT_OF_WORK, type FinancialStore, type FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { WalletsController } from '../../src/modules/wallets/infrastructure/wallets.controller';
import { createHarness, type Harness } from '../support/postgres';

let h: Harness;
let app: INestApplication;
let url: string;
const originalDatabaseUrl = process.env['DATABASE_URL'];
const input = (playerId = crypto.randomUUID(), amount = '1000.00', currency = 'BRL') => ({ playerId, initialBalance: { amount, currency } });
async function start(uow: FinancialUnitOfWork) {
  const application = await NestFactory.create(AppModule.register({ uow }), { logger: false, abortOnError: false });
  try { await application.listen(0, '127.0.0.1'); return application; } catch (error) { await application.close(); throw error; }
}
function post(body: unknown, base = url) {
  return fetch(`${base}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'untrusted-client-value' }, body: JSON.stringify(body) });
}
async function counts() {
  const result: Record<string, string> = {};
  for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages', 'inbox_messages']) {
    const rows = await h.orm.em.getConnection().execute<{ count: string }[]>(`select count(*)::text as count from "${h.schema}".${table}`);
    result[table] = rows[0]!.count;
  }
  return result;
}
beforeAll(async () => {
  h = await createHarness();
  // Deliberately unusable development configuration: injected composition must never consult it.
  process.env['DATABASE_URL'] = 'postgresql://127.0.0.1:1/jungle_dev';
  try { app = await start(h.uow); url = await app.getUrl(); }
  catch (error) { await h.close(); throw error; }
}, 20000);
afterAll(async () => {
  try { await app?.close(); } finally {
    try { if (h) await h.close(); } finally {
      if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = originalDatabaseUrl;
    }
  }
});

test('explicit HTTP composition uses only the harness database, schema and UoW without an extra ORM or workers', async () => {
  const identity = await h.orm.em.getConnection().execute<{ database: string; schema: string }[]>('select current_database() as database, current_schema() as schema');
  expect(identity).toEqual([{ database: 'jungle_test', schema: h.schema }]);
  expect(app.get<FinancialUnitOfWork>(FINANCIAL_UNIT_OF_WORK)).toBe(h.uow);
  expect(app.get(CreateWalletUseCase)).toBeInstanceOf(CreateWalletUseCase);
  expect(app.get(GetWalletUseCase)).toBeInstanceOf(GetWalletUseCase);
  expect(app.get(WalletsController)).toBeInstanceOf(WalletsController);
  const modules = [...app.get(ModulesContainer).values()];
  expect(modules.filter(m => m.metatype === DatabaseModule)).toHaveLength(1);
  expect(modules.flatMap(m => [...m.providers.keys()]).filter(p => p === CoreORM)).toHaveLength(0);
  const names = modules.flatMap(m => [...m.providers.values()].map(p => p.metatype?.name ?? ''));
  expect(names.filter(name => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(name))).toEqual([]);
});

test('positive HTTP opening returns exact contract and commits opening, ledger and correlated events in isolated schema', async () => {
  const body = input();
  const response = await post(body);
  expect(response.status).toBe(201);
  const wallet = await response.json() as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
  expect(wallet).toEqual({ id: wallet.id, playerId: body.playerId, balance: body.initialBalance, version: 1 });
  expect(wallet.id).toMatch(/^[a-f0-9-]{36}$/);
  const correlation = response.headers.get('x-correlation-id');
  expect(correlation).toMatch(/^[a-f0-9-]{36}$/);
  const query = await fetch(`${url}/wallets/${wallet.id.toUpperCase()}`);
  expect(query.status).toBe(200);
  expect(await query.json()).toEqual(wallet);
  expect(query.headers.get('x-correlation-id')).not.toBe(correlation);
  const wagers = await h.orm.em.getConnection().execute<{ kind: string; status: string; amount: string }[]>(`select kind, status, amount from "${h.schema}".wager_transactions where wallet_id = ?`, [wallet.id]);
  expect(wagers).toEqual([{ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' }]);
  const ledger = await h.orm.em.getConnection().execute<{ direction: string; amount: string; balance_before: string; balance_after: string }[]>(`select direction, amount, balance_before, balance_after from "${h.schema}".wallet_ledger_entries where wallet_id = ?`, [wallet.id]);
  expect(ledger).toEqual([{ direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00' }]);
  const events = await h.orm.em.getConnection().execute<{ payload: { correlationId: string }; event_type: string; published_at: unknown }[]>(`select payload, event_type, published_at from "${h.schema}".outbox_messages where aggregate_id = ?`, [wallet.id]);
  expect(events.map(e => e.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  expect(events.every(e => e.payload.correlationId === correlation && e.published_at === null)).toBe(true);
  expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
  expect((await h.get.execute(wallet.id)).balance.toString()).toBe('1000.00');
});

test('zero opening has no financial artifacts and duplicate uniqueness is player plus currency', async () => {
  const body = input(undefined, '0.00');
  const before = await counts();
  const response = await post(body);
  const wallet = await response.json() as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
  expect(response.status).toBe(201);
  expect(wallet).toEqual({ id: wallet.id, playerId: body.playerId, balance: body.initialBalance, version: 1 });
  const after = await counts();
  expect(after['wager_transactions']).toBe(before['wager_transactions']);
  expect(after['wallet_ledger_entries']).toBe(before['wallet_ledger_entries']);
  expect(after['outbox_messages']).toBe(before['outbox_messages']);
  const duplicate = await post(body);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ code: 'WALLET_ALREADY_EXISTS', message: 'Wallet already exists for player and currency' });
  expect(await counts()).toEqual(after);
  expect((await post(input(body.playerId, '0.00', 'USD'))).status).toBe(201);
  expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
});

test('missing wallet is 404, invalid internal ID is 400, unknown route and malformed JSON retain native statuses', async () => {
  const before = await counts();
  expect((await fetch(`${url}/wallets/${crypto.randomUUID()}`)).status).toBe(404);
  expect((await fetch(`${url}/wallets/invalid`)).status).toBe(400);
  expect((await fetch(`${url}/unknown`)).status).toBe(404);
  const malformed = await fetch(`${url}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ code: 'BAD_REQUEST', message: 'Bad request' });
  expect(malformed.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
  for (const body of [null, [], { ...input(), extra: 1 }, { ...input(), initialBalance: { amount: '1.00', currency: 'BRL', extra: 1 } }]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(await counts()).toEqual(before);
});

test('twelve concurrent HTTP openings have one winner and one financial bundle', async () => {
  const body = input();
  const responses = await Promise.all(Array.from({ length: 12 }, () => post(body)));
  expect(responses.filter(r => r.status === 201)).toHaveLength(1);
  expect(responses.filter(r => r.status === 409)).toHaveLength(11);
  const winner = await responses.find(r => r.status === 201)!.json() as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
  const rows = await h.orm.em.getConnection().execute<{ count: string }[]>(`select count(*)::text as count from "${h.schema}".wallet_ledger_entries where wallet_id = ?`, [winner.id]);
  expect(rows).toEqual([{ count: '1' }]);
  expect((await h.reconcile.execute(winner.id)).consistent).toBe(true);
});

for (const method of ['insertWallet', 'insertWager', 'appendLedger', 'enqueue', 'beforeCommit'] as const) {
  test(`HTTP failure after ${method} rolls back all financial artifacts`, async () => {
    const before = await counts();
    const uow: FinancialUnitOfWork = { run: work => h.uow.run(async store => {
      const result = await work(new Proxy(store, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const result: unknown = await value.apply(target, args);
          if (key === method) throw new Error('injected private SQL details');
          return result;
        };
      },
    }) as FinancialStore);
      if (method === 'beforeCommit') throw new Error('injected before commit');
      return result;
    }) };
    const failing = await start(uow);
    try {
      const response = await post(input(), await failing.getUrl());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
      expect(await counts()).toEqual(before);
    } finally { await failing.close(); }
    expect(await h.orm.isConnected()).toBe(true);
  });
}

test('production HTTP composition initializes exactly one ORM and pool at context creation and closes it', async () => {
  const previous = process.env['DATABASE_URL'];
  // AppModule was imported earlier with another environment: configuration must be resolved now.
  process.env['DATABASE_URL'] = h.url;
  const initialize = MikroORM.init.bind(MikroORM);
  // Only the schema is adapted at the real init boundary, as in the existing worker smokes.
  // The production Nest graph and real ORM/pool lifecycle remain under test.
  const init = spyOn(MikroORM, 'init').mockImplementation((async (options: Parameters<typeof MikroORM.init>[0]) => {
    if (!options || options.clientUrl !== h.url) throw new Error('Unexpected HTTP test database');
    return initialize({ ...options, schema: h.schema,
      driverOptions: { ...options.driverOptions, connection: { ...options.driverOptions?.connection, options: `-c search_path=${h.schema}` } } });
  }) as typeof MikroORM.init);
  let production: INestApplication | undefined;
  let owned: MikroORM | undefined;
  try {
    production = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await production.listen(0, '127.0.0.1');
    expect(init).toHaveBeenCalledTimes(1);
    const modules = [...production.get(ModulesContainer).values()];
    const ormProviders = modules.flatMap(m => [...m.providers.entries()]).filter(([token]) => token === CoreORM);
    expect(ormProviders).toHaveLength(1);
    owned = production.get<MikroORM>(CoreORM);
    expect(ormProviders[0]![1].instance).toBe(owned);
    expect(owned).not.toBe(h.orm);
    const connections = owned.em.getConnection();
    expect(await connections.execute<{ database: string; schema: string }[]>(
      'select current_database() as database, current_schema() as schema')).toEqual([{ database: 'jungle_test', schema: h.schema }]);
    expect(connections.getKnex().client.pool).toBeDefined();
    expect(owned.config.get('replicas') ?? []).toHaveLength(0);
    expect(modules.filter(m => m.metatype === DatabaseModule)).toHaveLength(1);
    expect(modules.flatMap(m => [...m.providers.values()]).filter(p => /Consumer|Publisher|PendingReferenceWorker|Lifecycle/.test(p.metatype?.name ?? ''))).toHaveLength(0);
    expect((await fetch(await production.getUrl())).status).toBe(404);
  } finally {
    await production?.close(); init.mockRestore();
    if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous;
  }
  expect(await owned?.isConnected()).toBe(false);
  expect(await h.orm.isConnected()).toBe(true);
});
