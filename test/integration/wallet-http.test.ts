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

import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind as K } from '../../src/modules/wagering/domain/wager-transaction';
import { request } from '../support/postgres';
import { ListWalletLedgerUseCase } from '../../src/modules/wallets/application/wallet-queries';

type LedgerHttpPage = { entries: { id: string; walletId: string; transactionId: string; direction: string; money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string }; balanceAfter: { amount: string; currency: string }; createdAt: string }[]; nextCursor: string | null };
async function ledgerGet(walletId: string, query = '') {
  const response = await fetch(`${url}/wallets/${walletId}/ledger${query}`);
  return { response, page: await response.json() as LedgerHttpPage };
}
async function ledgerDatabaseSnapshot() {
  const result: Record<string, unknown> = {};
  for (const [table, order] of [['wallets', 'id'], ['wager_transactions', 'id'], ['wallet_ledger_entries', 'id'], ['inbox_messages', 'consumer_name,message_id'], ['outbox_messages', 'id']]) {
    result[table!] = await h.orm.em.fork().execute(`select * from "${h.schema}".${table} order by ${order}`);
  }
  return result;
}
test('CP03 ledger empty/single pages have exact contracts and GET leaves all five tables unchanged', async () => {
  const empty = await h.wallet('0.00'); const wallet = await h.wallet('1000.00');
  const before = await ledgerDatabaseSnapshot();
  const zero = await ledgerGet(empty.id);
  expect(zero.response.status).toBe(200); expect(zero.page).toEqual({ entries: [], nextCursor: null });
  const { response, page } = await ledgerGet(wallet.id.toUpperCase(), '?limit=1');
  expect(response.status).toBe(200); expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
  const rows = await h.orm.em.fork().execute<{ id: string; transaction_id: string }[]>('select id,transaction_id from wallet_ledger_entries where wallet_id=?', [wallet.id]);
  expect(page).toEqual({ entries: [{ id: rows[0]!.id, walletId: wallet.id, transactionId: rows[0]!.transaction_id, direction: 'CREDIT',
    money: { amount: '1000.00', currency: 'BRL' }, balanceBefore: { amount: '0.00', currency: 'BRL' }, balanceAfter: { amount: '1000.00', currency: 'BRL' }, createdAt: wallet.createdAt.toISOString() }], nextCursor: null });
  const missing = await ledgerGet(crypto.randomUUID());
  expect(missing.response.status).toBe(404); expect(missing.page as unknown).toEqual({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });
  expect(await ledgerDatabaseSnapshot()).toEqual(before);
});
test('CP03 ledger paginates 121 identical timestamps as 50+50+21 with exact descending order and wallet isolation', async () => {
  const wallet = await h.wallet('0.00'); const other = await h.wallet();
  const fixed = new Date('2026-11-04T12:00:00.123Z');
  const process = new ProcessWagerTransactionUseCase(h.uow, { now: () => fixed });
  for (let index = 0; index < 121; index++) await process.execute(request(wallet, { kind: K.Win, money: { amount: '1.00', currency: 'BRL' } }));
  const expected = await h.orm.em.fork().execute<{ id: string }[]>('select id from wallet_ledger_entries where wallet_id=? order by created_at desc,id desc', [wallet.id]);
  const before = await ledgerDatabaseSnapshot();
  const ids: string[] = []; const lengths: number[] = []; let cursor: string | null = null;
  do {
    const result = await ledgerGet(wallet.id, cursor ? `?cursor=${cursor}` : '');
    expect(result.response.status).toBe(200); lengths.push(result.page.entries.length);
    expect(result.page.entries.every(entry => entry.walletId === wallet.id)).toBe(true);
    ids.push(...result.page.entries.map(entry => entry.id)); cursor = result.page.nextCursor;
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      expect(decoded).toEqual({ createdAt: '2026-11-04T12:00:00.123000Z', id: result.page.entries.at(-1)!.id });
    }
  } while (cursor);
  expect(lengths).toEqual([50, 50, 21]); expect(ids).toEqual(expected.map(row => row.id)); expect(new Set(ids).size).toBe(121);
  expect((await ledgerGet(wallet.id, '?limit=100')).page.entries).toHaveLength(100);
  expect((await ledgerGet(other.id)).page.entries).toHaveLength(1);
  expect(await ledgerDatabaseSnapshot()).toEqual(before);
}, 15000);
test('CP03 distinct microseconds in one millisecond survive cursor boundaries without omission', async () => {
  const wallet = await h.wallet('0.00');
  // Adapt only the timestamp at INSERT in this disposable fixture. No ledger UPDATE or disabled constraint.
  let inserted = 0;
  const fixture: FinancialUnitOfWork = { run: work => h.uow.run(store => work(new Proxy(store, {
    get(target, key) {
      if (key === 'appendLedger') return async (entry: import('../../src/modules/wallets/domain/wallet-ledger-entry').WalletLedgerEntry) => {
        const timestamp = `2026-11-04T12:00:00.123${['001', '999', '500'][inserted++]}Z`;
        // Use the same transactional EM as the real store, preserving deferred consistency checks.
        const em = Reflect.get(target, 'em') as import('@mikro-orm/postgresql').EntityManager;
        await em.execute(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
          values(?,?,?,?,?,?,?,?,?::timestamptz)`, [entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.toString(), entry.money.currency,
          entry.balanceBefore.toString(), entry.balanceAfter.toString(), timestamp]);
      };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as FinancialStore)) };
  const process = new ProcessWagerTransactionUseCase(fixture);
  for (let n = 0; n < 3; n++) await process.execute(request(wallet, { kind: K.Win, money: { amount: '1.00', currency: 'BRL' } }));
  const expected = await h.orm.em.fork().execute<{ id: string }[]>('select id from wallet_ledger_entries where wallet_id=? order by created_at desc,id desc', [wallet.id]);
  const before = await ledgerDatabaseSnapshot(); const ids: string[] = []; const positions: string[] = []; let cursor: string | null = null;
  do {
    const result = await ledgerGet(wallet.id, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    expect(result.response.status).toBe(200); expect(result.page.entries).toHaveLength(1);
    ids.push(result.page.entries[0]!.id); expect(result.page.entries[0]!.createdAt).toBe('2026-11-04T12:00:00.123Z');
    cursor = result.page.nextCursor; if (cursor) positions.push(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).createdAt);
  } while (cursor);
  expect(positions).toEqual(['2026-11-04T12:00:00.123999Z', '2026-11-04T12:00:00.123500Z']);
  expect(ids).toEqual(expected.map(row => row.id)); expect(new Set(ids).size).toBe(3);
  expect(await ledgerDatabaseSnapshot()).toEqual(before); expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
});
test('CP03 invalid ledger HTTP queries are 400 and preserve every persisted table', async () => {
  const wallet = await h.wallet(); const before = await ledgerDatabaseSnapshot();
  const badCursor = Buffer.from(JSON.stringify({ createdAt: '2026-02-30T12:00:00.123456Z', id: wallet.id })).toString('base64url');
  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=10.0', 'limit=1e1', 'limit=0x10', 'limit=010', 'limit=',
    'limit=10&limit=20', 'limit[]=10', 'unknown=1', 'cursor=', 'cursor=a&cursor=b', `cursor=${badCursor}`]) {
    expect((await ledgerGet(wallet.id, `?${query}`)).response.status).toBe(400);
  }
  expect((await ledgerGet('invalid')).response.status).toBe(400); expect(await ledgerDatabaseSnapshot()).toEqual(before);
});

import { ReconcileWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { PostgresFinancialStore } from '../../src/database/postgres-financial-store';
import { IsolationLevel } from '@mikro-orm/core';
import { sqlError } from '../../src/shared/application/application-errors';

async function reconciliationPost(walletId: string, base = url, body?: string) {
  return fetch(`${base}/wallets/${walletId}/reconciliation`, { method: 'POST', headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }) });
}
async function reconciliationSnapshot(em: import('@mikro-orm/postgresql').EntityManager) {
  const result: Record<string, unknown> = {};
  for (const [table, order] of [['wallets', 'id'], ['wager_transactions', 'id'], ['wallet_ledger_entries', 'id'], ['inbox_messages', 'consumer_name,message_id'], ['outbox_messages', 'id']]) {
    result[table!] = await em.execute(`select * from "${h.schema}".${table} order by ${order}`);
  }
  return result;
}
test('CP04 real reconciliation covers empty/opening/credits/debits and preserves all five tables', async () => {
  const zero = await h.wallet('0.00'); const wallet = await h.wallet('100.00');
  const metricBefore = app.get(ReconcileWalletUseCase).divergenceObservations;
  const before = await ledgerDatabaseSnapshot();
  for (const [w, balance, checkedEntries, body] of [[zero, '0.00', 0, undefined], [wallet, '100.00', 1, '{}']] as const) {
    const response = await reconciliationPost(w.id, url, body); expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(await response.json()).toEqual({ walletId: w.id, storedBalance: { amount: balance, currency: 'BRL' }, calculatedBalance: { amount: balance, currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries });
  }
  expect(await ledgerDatabaseSnapshot()).toEqual(before);
  await h.process.execute(request(wallet, { money: { amount: '25.10', currency: 'BRL' } }));
  await h.process.execute(request(wallet, { kind: K.Win, money: { amount: '0.30', currency: 'BRL' } }));
  const moved = await ledgerDatabaseSnapshot();
  const response = await reconciliationPost(wallet.id); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ walletId: wallet.id, storedBalance: { amount: '75.20', currency: 'BRL' }, calculatedBalance: { amount: '75.20', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 3 });
  expect(await ledgerDatabaseSnapshot()).toEqual(moved);
  expect(app.get(ReconcileWalletUseCase).divergenceObservations).toBe(metricBefore);
  const missing = await reconciliationPost(crypto.randomUUID()); expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });
});

for (const mode of ['stored-above', 'stored-below', 'negative-total'] as const) {
  test(`CP04 VAL02-01 real SQL ${mode}; HTTP is controlled replay after rejected fixture commit`, async () => {
    const negative = mode === 'negative-total'; const wallet = await h.wallet(negative ? '0.00' : '100.00');
    const before = await ledgerDatabaseSnapshot(); let rejectedCommits = 0; let captured = 0;
    // Controlled simulation: execute real reconciliation SQL against our own temporary
    // fixture, capture its diagnosis, then return that diagnosis only AFTER PostgreSQL
    // rejects the inconsistent commit and rolls back. This is not committed corruption.
    const fixture: FinancialUnitOfWork = { async run<T>(work: (store: FinancialStore) => Promise<T>, isolation?: 'read committed' | 'repeatable read'): Promise<T> {
      expect(isolation).toBe('repeatable read'); let diagnosis: { value: T } | undefined;
      try {
        await h.orm.em.fork({ clear: true, useContext: false }).transactional(async em => {
          expect(await em.execute('show transaction_isolation')).toEqual([{ transaction_isolation: 'repeatable read' }]);
          const triggers = await em.execute<{ tgname: string; tgenabled: string; tgdeferrable: boolean; tginitdeferred: boolean }[]>(
            `select tgname,tgenabled,tgdeferrable,tginitdeferred from pg_trigger where tgrelid in ('wallets'::regclass,'wallet_ledger_entries'::regclass) and tgname in ('trg_wallet_ledger_total','trg_ledger_wallet_total') order by tgname`);
          expect(triggers).toHaveLength(2);
          expect(triggers.every(t => t.tgenabled === 'O' && t.tgdeferrable && t.tginitdeferred)).toBe(true);
          if (negative) {
            const transactionId = crypto.randomUUID();
            await em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,recorded_balance_amount,recorded_balance_currency,processed_at)
              values(?,?,?,?,?,?,?,?,'fixture','BET',25,'BRL','PROCESSED',75,'BRL',now())`,
              [transactionId, 'reconciliation-fixture', crypto.randomUUID(), crypto.randomUUID(), 'a'.repeat(64), wallet.id, wallet.playerId, crypto.randomUUID()]);
            await em.execute(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) values(?,?,?,'DEBIT',25,'BRL',100,75)`,
              [crypto.randomUUID(), wallet.id, transactionId]);
          } else {
            await em.execute('update wallets set balance=?,version=version+1 where id=?', [mode === 'stored-above' ? '105.00' : '95.00', wallet.id]);
          }
          const store = new PostgresFinancialStore(em);
          expect(await store.ledgerTotal(wallet.id)).toEqual({ amount: negative ? '-25.00' : '100.00', count: 1 });
          const fixtureState = await reconciliationSnapshot(em);
          diagnosis = { value: await work(store) }; captured++;
          expect(await reconciliationSnapshot(em)).toEqual(fixtureState); // The diagnosis did not repair or mutate the fixture.
        }, { isolationLevel: IsolationLevel.REPEATABLE_READ });
        throw new Error('Inconsistent fixture unexpectedly committed');
      } catch (error) {
        if (sqlError(error).code !== '23514' || !diagnosis) throw error;
        rejectedCommits++;
        return diagnosis.value;
      }
    } };
    const application = await start(fixture); const log = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 1; i <= 2; i++) {
        const response = await reconciliationPost(wallet.id, await application.getUrl()); expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ walletId: wallet.id,
          storedBalance: { amount: negative ? '0.00' : mode === 'stored-above' ? '105.00' : '95.00', currency: 'BRL' },
          calculatedBalance: { amount: negative ? '-25.00' : '100.00', currency: 'BRL' },
          difference: { amount: negative ? '25.00' : mode === 'stored-above' ? '5.00' : '-5.00', currency: 'BRL' }, consistent: false, checkedEntries: 1 });
        expect(application.get(ReconcileWalletUseCase).divergenceObservations).toBe(BigInt(i));
        expect(log).toHaveBeenCalledTimes(i);
        expect(JSON.parse(log.mock.calls[i - 1]![0] as string)).toEqual({ event: 'WalletReconciliationMismatch', walletId: wallet.id, correlationId: response.headers.get('x-correlation-id') });
        expect(await ledgerDatabaseSnapshot()).toEqual(before); // All fixture mutations were rolled back.
      }
      expect(captured).toBe(2); expect(rejectedCommits).toBe(2);
      expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
    } finally { log.mockRestore(); await application.close(); }
  });
}

test('CP04 REPEATABLE READ barrier preserves snapshot across a concurrent committed debit', async () => {
  const wallet = await h.wallet('100.00'); let signal!: () => void; let release!: () => void; let paused = false;
  const read = new Promise<void>(resolve => { signal = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const isolated: FinancialUnitOfWork = { run: (work, isolation) => {
    expect(isolation).toBe('repeatable read');
    return h.uow.run(store => work(new Proxy(store, {
      get(target, key) {
        if (key === 'getWallet') return async (id: string) => {
          const result = await target.getWallet(id);
          if (!paused) { paused = true; signal(); await gate; }
          return result;
        };
        if (key === 'ledgerTotal') return async (id: string) => {
          const em = Reflect.get(target, 'em') as import('@mikro-orm/postgresql').EntityManager;
          expect(await em.execute('show transaction_isolation')).toEqual([{ transaction_isolation: 'repeatable read' }]);
          return target.ledgerTotal(id);
        };
        const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      },
    })), isolation);
  } };
  const application = await start(isolated);
  let pending: Promise<Response> | undefined;
  try {
    pending = reconciliationPost(wallet.id, await application.getUrl());
    await read;
    await h.process.execute(request(wallet, { money: { amount: '25.00', currency: 'BRL' } })); // Commit finishes while reconciliation is paused.
    expect((await h.get.execute(wallet.id)).balance.toString()).toBe('75.00');
    const afterMovement = await ledgerDatabaseSnapshot(); release();
    const first = await pending; expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ walletId: wallet.id, storedBalance: { amount: '100.00', currency: 'BRL' }, calculatedBalance: { amount: '100.00', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 1 });
    const second = await reconciliationPost(wallet.id, await application.getUrl()); expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ walletId: wallet.id, storedBalance: { amount: '75.00', currency: 'BRL' }, calculatedBalance: { amount: '75.00', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 2 });
    expect(await ledgerDatabaseSnapshot()).toEqual(afterMovement);
    expect(application.get(ReconcileWalletUseCase).divergenceObservations).toBe(0n);
  } finally { release(); if (pending) await pending; await application.close(); }
}, 15000);
