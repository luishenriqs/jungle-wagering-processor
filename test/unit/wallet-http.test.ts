import 'reflect-metadata';
import { test, expect, spyOn } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';

test('HTTP foundation without database rejects financial requests with 503', async () => {
  const previous = process.env['DATABASE_URL'];
  delete process.env['DATABASE_URL'];
  const init = spyOn(MikroORM, 'init');
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'player-test-01', initialBalance: { amount: '1000.00', currency: 'BRL' } }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' });
    expect((await fetch(await app.getUrl())).status).toBe(404);
    expect((await fetch(`${await app.getUrl()}/wallets/${crypto.randomUUID()}`)).status).toBe(503);
    expect(init).toHaveBeenCalledTimes(0);
    const ormInstances = [...app.get(ModulesContainer).values()].flatMap(m => [...m.providers.entries()])
      .filter(([token]) => token === CoreORM).map(([, provider]) => provider.instance);
    expect(ormInstances).toEqual([null]);
  } finally {
    await app.close();
    init.mockRestore();
    if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous;
  }
});

import { HttpException, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { WalletsController } from '../../src/modules/wallets/infrastructure/wallets.controller';
import { createWalletHttpInput, toWalletHttpResponse } from '../../src/modules/wallets/infrastructure/wallet-http.dto';
import { publicHttpError } from '../../src/shared/infrastructure/http-exception.filter';
import { ProviderIdentityGuard } from '../../src/shared/infrastructure/provider-identity.guard';
import { ConflictError, NotFoundError, PersistenceInvariantError, RetryExhaustedError } from '../../src/shared/application/application-errors';
import { CurrencyMismatchError, IdempotencyConflictError, InvalidDomainInputError, InvalidMoneyError, MoneyOverflowError } from '../../src/shared/domain/domain-errors';
import type { FinancialUnitOfWork } from '../../src/shared/application/financial-store';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';
import { ReconcileWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';

function reconciliationFixture(stored: string, amount: string, count = 1) {
  const wallet = Wallet.rehydrate({ id: crypto.randomUUID(), playerId: 'reconciliation-test', currency: 'BRL', balance: Money.from({ amount: stored, currency: 'BRL' }), version: 1, createdAt: new Date(), updatedAt: new Date() });
  let calls = 0;
  const uow: FinancialUnitOfWork = { async run(work, isolation) {
    calls++; expect(isolation).toBe('repeatable read');
    return work({ getWallet: async () => wallet, ledgerTotal: async () => ({ amount, count }) } as unknown as FinancialStore);
  } };
  return { wallet, uow, calls: () => calls, reconcile: new ReconcileWalletUseCase(uow) };
}
test('CP04 RED-01 reconciliation endpoint returns 200', async () => {
  const f = reconciliationFixture('0.00', '0.00', 0);
  const application = await NestFactory.create(AppModule.register({ uow: f.uow }), { logger: false, abortOnError: false });
  try {
    await application.listen(0, '127.0.0.1');
    const response = await fetch(`${await application.getUrl()}/wallets/${f.wallet.id}/reconciliation`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ walletId: f.wallet.id, storedBalance: { amount: '0.00', currency: 'BRL' }, calculatedBalance: { amount: '0.00', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 0 });
  } finally { await application.close(); }
});
test('CP04 RED-02 negative aggregate produces signed diagnosis', async () => {
  const f = reconciliationFixture('0.00', '-25.00');
  const log = spyOn(console, 'warn').mockImplementation(() => {});
  try { const r = await f.reconcile.execute(f.wallet.id); expect(r.calculatedBalance.amount).toBe('-25.00'); expect(r.difference.amount).toBe('25.00'); expect(r.consistent).toBe(false); }
  finally { log.mockRestore(); }
});
test('CP04 RED-03 internal money overflow is an invariant and HTTP 500', async () => {
  const f = reconciliationFixture('0.00', '10000000000000000.00');
  let failure: unknown;
  try { await f.reconcile.execute(f.wallet.id); } catch (error) { failure = error; }
  expect(publicHttpError(failure).status).toBe(500);
  expect(failure).toBeInstanceOf(PersistenceInvariantError);
});
test('CP04 RED-04 divergence metric is readable and log is correlated', async () => {
  const f = reconciliationFixture('100.00', '95.00'); const correlationId = crypto.randomUUID();
  const log = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(Reflect.get(f.reconcile, 'divergenceObservations')).toBe(0n);
    await Reflect.apply(f.reconcile.execute, f.reconcile, [f.wallet.id, { correlationId }]);
    expect(Reflect.get(f.reconcile, 'divergenceObservations')).toBe(1n);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: 'WalletReconciliationMismatch', walletId: f.wallet.id, correlationId });
  } finally { log.mockRestore(); }
});
test('CP04 RED-05 invalid UUID never opens UoW', async () => {
  const f = reconciliationFixture('0.00', '0.00');
  await expect(f.reconcile.execute('invalid')).rejects.toBeInstanceOf(InvalidDomainInputError);
  expect(f.calls()).toBe(0);
});

const valid = { playerId: 'player-test-01', initialBalance: { amount: '1000.00', currency: 'BRL' } };
export const invalidBodies: unknown[] = [null, [], 'text', 1, {}, { ...valid, playerId: null }, { ...valid, playerId: 1 },
  { ...valid, playerId: '' }, { ...valid, playerId: '  ' }, { ...valid, initialBalance: null }, { ...valid, initialBalance: [] },
  { ...valid, extra: true }, { ...valid, initialBalance: { ...valid.initialBalance, extra: true } },
  ...[1000, null, '', '-1.00', '1.001', '1e2', 'NaN', 'Infinity', '1', '10000000000000000.00'].map(amount => ({ ...valid, initialBalance: { amount, currency: 'BRL' } })),
  ...[null, 1, '', 'brl', 'ZZZ'].map(currency => ({ ...valid, initialBalance: { amount: '1.00', currency } }))];
for (const [index, body] of invalidBodies.entries()) {
  test(`strict wallet contract rejects invalid input ${index}`, () => { expect(() => createWalletHttpInput(body)).toThrow(); });
}
test('wallet input and public projection preserve exact money without internal fields', () => {
  expect(createWalletHttpInput(valid)).toEqual(valid);
  const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: valid.playerId, initialBalance: Money.zero('BRL'), at: new Date() });
  expect(toWalletHttpResponse(wallet)).toEqual({ id: wallet.id, playerId: valid.playerId, balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
  expect(new ProviderIdentityGuard().canActivate()).toBe(true);
});
const sensitive = 'secret SQL postgres://user:password@host/database';
const errorCases: [unknown, number, string][] = [
  [new InvalidDomainInputError(sensitive), 400, 'INVALID_INPUT'], [new InvalidMoneyError(sensitive), 400, 'INVALID_MONEY'],
  [new MoneyOverflowError(sensitive), 400, 'MONEY_OVERFLOW'], [new CurrencyMismatchError(sensitive), 400, 'CURRENCY_MISMATCH'],
  [new NotFoundError(sensitive), 404, 'WALLET_NOT_FOUND'], [new ConflictError(sensitive), 409, 'WALLET_ALREADY_EXISTS'],
  [new IdempotencyConflictError(sensitive), 409, 'IDEMPOTENCY_CONFLICT'], [new RetryExhaustedError(sensitive), 503, 'SERVICE_UNAVAILABLE'],
  [new PersistenceInvariantError(sensitive, { cause: { code: '40001' } }), 500, 'INTERNAL_SERVER_ERROR'],
  [new Error(sensitive), 500, 'INTERNAL_SERVER_ERROR'], [new BadRequestException(sensitive), 400, 'BAD_REQUEST'],
  [new NotFoundException(sensitive), 404, 'NOT_FOUND'], [new HttpException(sensitive, 418), 418, 'HTTP_ERROR'],
  ...['40P01', '40001', '55P03', '57014', '08006', '57P01', '57P02', '57P03', '53300', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].map(code => [new Error(sensitive, { cause: { code } }), 503, 'SERVICE_UNAVAILABLE'] as [unknown, number, string]),
  ...['23505', '23514', '42601', '28P01', '42P01', '08invalid'].map(code => [{ code, message: sensitive }, 500, 'INTERNAL_SERVER_ERROR'] as [unknown, number, string]),
];
for (const [index, [error, status, code]] of errorCases.entries()) {
  test(`central error mapping ${index} sanitizes internal details`, () => {
    const result = publicHttpError(error);
    expect(result.status).toBe(status); expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
}
test('HTTP errors use the central filter, invalid contracts never reach the UoW, and correlation is per request', async () => {
  let calls = 0;
  let failure: unknown = new PersistenceInvariantError(sensitive);
  const uow: FinancialUnitOfWork = { async run() { calls++; throw failure; } };
  const app = await NestFactory.create(AppModule.register({ uow }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const request = (body: string) => fetch(`${url}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'untrusted' }, body });
    for (const body of invalidBodies) expect((await request(JSON.stringify(body))).status).toBe(400);
    const malformed = await request('{');
    expect(malformed.status).toBe(400);
    expect((await fetch(`${url}/wallets/not-a-uuid`)).status).toBe(400);
    expect(calls).toBe(0);
    const root = await fetch(url);
    expect(root.status).toBe(404);
    const ids = [malformed.headers.get('x-correlation-id'), root.headers.get('x-correlation-id')];
    for (const id of ids) expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
    for (const [error, status, code] of errorCases) {
      failure = error;
      const response = await fetch(`${url}/wallets/${crypto.randomUUID()}`);
      expect(response.status).toBe(status);
      const body = await response.json();
      const { status: _, ...expected } = publicHttpError(error);
      expect(body).toEqual(expected);
      expect((body as { code: string }).code).toBe(code);
      expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(app.get(WalletsController)).toBeInstanceOf(WalletsController);
    expect(app.get(CreateWalletUseCase)).toBeInstanceOf(CreateWalletUseCase);
    expect(app.get(GetWalletUseCase)).toBeInstanceOf(GetWalletUseCase);
    const modules = [...app.get(ModulesContainer).values()];
    expect(modules.flatMap(m => [...m.providers.keys()]).filter(p => p === CoreORM)).toHaveLength(0);
    expect(modules.filter(m => /Consumer|Publisher|PendingReference/.test(m.metatype.name))).toHaveLength(0);
  } finally { await app.close(); }
});

test('present but invalid database configuration fails startup instead of falling back', async () => {
  const previous = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = '';
  try {
    await expect(NestFactory.create(AppModule, { logger: false, abortOnError: false })).rejects.toThrow('DATABASE_URL is required');
  } finally {
    if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous;
  }
});

import { ListWalletLedgerUseCase } from '../../src/modules/wallets/application/wallet-queries';
import type { FinancialStore } from '../../src/shared/application/financial-store';

const queryWalletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('CP03 ledger GET exists and returns explicit empty-page contract', async () => {
  const store = { async getWallet() { return Wallet.open({ id: queryWalletId, playerId: 'player-test', initialBalance: Money.zero('BRL'), at: new Date() }); }, async ledgerPage() { return []; } } as unknown as FinancialStore;
  const app = await NestFactory.create(AppModule.register({ uow: { run: work => work(store) } }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/wallets/${queryWalletId}/ledger`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [], nextCursor: null });
  } finally { await app.close(); }
});

test('CP03 invalid cursor calendar is rejected before the application opens a UoW', async () => {
  let calls = 0;
  const reader = new ListWalletLedgerUseCase({ async run() { calls++; throw new InvalidDomainInputError('test persistence boundary reached'); } });
  await expect(reader.execute({ walletId: queryWalletId, cursor: encodeCursor({ createdAt: '2026-02-30T12:00:00.123456Z', id: queryWalletId }) })).rejects.toBeInstanceOf(InvalidDomainInputError);
  expect(calls).toBe(0);
});

test('CP03 invalid ledger query is HTTP 400 without UoW access', async () => {
  let calls = 0;
  const app = await NestFactory.create(AppModule.register({ uow: { async run() { calls++; throw new Error('must not query'); } } }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/wallets/${queryWalletId}/ledger?limit=1e1`);
    expect(response.status).toBe(400); expect(calls).toBe(0);
  } finally { await app.close(); }
});

import { parseLedgerCursor } from '../../src/modules/wallets/application/wallet-queries';
import { ledgerHttpQuery, toLedgerHttpResponse } from '../../src/modules/wallets/infrastructure/wallet-http.dto';
import { WalletLedgerEntry, LedgerDirection } from '../../src/modules/wallets/domain/wallet-ledger-entry';

const cursorTimestamp = '2026-11-04T12:00:00.123456Z';
const invalidLedgerCursors: unknown[] = ['', 'a'.repeat(513), 'bad=', 'bad+', 'bad/', 'bad ', 'invalid', 1, null, [], {},
  ...[null, [], 'text', 1, {}, { createdAt: cursorTimestamp }, { id: queryWalletId },
    { createdAt: cursorTimestamp, id: queryWalletId, extra: true }, { createdAt: cursorTimestamp, id: 'invalid' },
    { createdAt: cursorTimestamp, id: null }, { createdAt: 1, id: queryWalletId }].map(encodeCursor),
  ...['2026-02-30T12:00:00.123456Z', '2026-02-29T12:00:00.123456Z', '2026-04-31T12:00:00.123456Z',
    '0000-01-01T00:00:00.000000Z', '2026-11-04T24:00:00.000000Z', '2026-13-01T00:00:00.000000Z',
    '2026-00-01T00:00:00.000000Z', '2026-01-00T00:00:00.000000Z', '2026-01-01T00:60:00.000000Z',
    '2026-01-01T00:00:60.000000Z', '2026-01-01T00:00:00.123Z', '2026-01-01T00:00:00.123456+00:00',
    '2026-01-01 00:00:00.123456Z'].map(createdAt => encodeCursor({ createdAt, id: queryWalletId }))];
for (const [index, cursor] of invalidLedgerCursors.entries()) {
  test(`CP03 invalid cursor ${index} is rejected at both boundaries before UoW`, async () => {
    expect(() => ledgerHttpQuery({ cursor })).toThrow(InvalidDomainInputError);
    let calls = 0;
    const reader = new ListWalletLedgerUseCase({ async run() { calls++; throw new Error('must not query'); } });
    await expect(reader.execute({ walletId: queryWalletId, cursor: cursor as string })).rejects.toBeInstanceOf(InvalidDomainInputError);
    expect(calls).toBe(0);
  });
}
for (const timestamp of ['0001-01-01T00:00:00.000001Z', '0099-12-31T23:59:59.999999Z', '2000-02-29T12:00:00.123456Z', '2024-02-29T00:00:00.000000Z', '9999-12-31T23:59:59.999999Z', cursorTimestamp]) {
  test(`CP03 valid cursor preserves all original microseconds: ${timestamp}`, () => {
    const cursor = encodeCursor({ createdAt: timestamp, id: queryWalletId.toUpperCase() });
    expect(parseLedgerCursor(cursor)).toEqual({ createdAt: timestamp, id: queryWalletId });
    expect(ledgerHttpQuery({ cursor, limit: '100' })).toEqual({ cursor, limit: 100 });
  });
}
const invalidLedgerQueries: unknown[] = [null, [], 1, { unknown: '1' }, { limit: ['10', '20'] }, { limit: {} }, { cursor: ['a', 'b'] },
  ...['0', '101', '-1', '10.0', '1e1', '0x10', '010', '', ' 10', '10 ', '+1', 'Infinity', '1'.repeat(400)].map(limit => ({ limit }))];
for (const [index, query] of invalidLedgerQueries.entries()) {
  test(`CP03 invalid ledger query ${index} is rejected without coercion`, () => expect(() => ledgerHttpQuery(query)).toThrow(InvalidDomainInputError));
}
test('CP03 ledger projection is exact, monetary strings and nextCursor null/string are preserved', () => {
  const entry = WalletLedgerEntry.create({ id: queryWalletId, walletId: queryWalletId, transactionId: queryWalletId, direction: LedgerDirection.Debit,
    money: Money.from({ amount: '25.00', currency: 'BRL' }), balanceBefore: Money.from({ amount: '1000.00', currency: 'BRL' }),
    balanceAfter: Money.from({ amount: '975.00', currency: 'BRL' }), createdAt: new Date('2026-11-05T12:00:00.123Z') });
  const expected = { id: queryWalletId, walletId: queryWalletId, transactionId: queryWalletId, direction: LedgerDirection.Debit, money: { amount: '25.00', currency: 'BRL' },
    balanceBefore: { amount: '1000.00', currency: 'BRL' }, balanceAfter: { amount: '975.00', currency: 'BRL' }, createdAt: '2026-11-05T12:00:00.123Z' };
  expect(toLedgerHttpResponse({ entries: [entry] })).toEqual({ entries: [expected], nextCursor: null });
  expect(toLedgerHttpResponse({ entries: [entry], nextCursor: 'opaque' })).toEqual({ entries: [expected], nextCursor: 'opaque' });
  expect(ledgerHttpQuery({})).toEqual({});
});
test('CP03 invalid ledger HTTP inputs never open UoW; unavailable persistence remains explicit 503', async () => {
  let calls = 0;
  const app = await NestFactory.create(AppModule.register({ uow: { async run() { calls++; throw new ServiceUnavailableException(); } } }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/wallets/${queryWalletId}/ledger`;
    const queries = ['limit=0', 'limit=101', 'limit=-1', 'limit=10.0', 'limit=1e1', 'limit=0x10', 'limit=010', 'limit=',
      'limit=%2010', 'limit=10%20', 'limit=10&limit=20', 'limit[]=10', 'limit[x]=10', 'unknown=1', 'cursor=', 'cursor=a&cursor=b'];
    for (const cursor of invalidLedgerCursors.filter((v): v is string => typeof v === 'string')) queries.push(`cursor=${encodeURIComponent(cursor)}`);
    for (const query of queries) {
      const response = await fetch(`${base}?${query}`);
      expect(response.status).toBe(400); expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect((await fetch(`${await app.getUrl()}/wallets/invalid/ledger`)).status).toBe(400);
    expect(calls).toBe(0);
    expect((await fetch(base)).status).toBe(503); expect(calls).toBe(1);
  } finally { await app.close(); }
});

for (const [stored, aggregate, count, difference, consistent] of [
  ['0.00', '0.00', 0, '0.00', true], ['100.00', '100.00', 1, '0.00', true],
  ['75.30', '75.30', 3, '0.00', true], ['100.00', '95.00', 2, '5.00', false],
  ['95.00', '100.00', 2, '-5.00', false], ['0.00', '-25.00', 1, '25.00', false],
  ['0.30', '0.10', 2, '0.20', false],
] as const) {
  test(`CP04 reconciliation exact calculation ${stored}/${aggregate}/${count}`, async () => {
    const f = reconciliationFixture(stored, aggregate, count); const events: unknown[] = []; const totals: bigint[] = [];
    const reconcile = new ReconcileWalletUseCase(f.uow, { log: event => { events.push(event); }, metric: total => { totals.push(total); } });
    expect(await reconcile.execute(f.wallet.id)).toEqual({ walletId: f.wallet.id, storedBalance: { amount: stored, currency: 'BRL' },
      calculatedBalance: { amount: aggregate, currency: 'BRL' }, difference: { amount: difference, currency: 'BRL' }, consistent, checkedEntries: count });
    expect(events).toHaveLength(consistent ? 0 : 1); expect(totals).toEqual(consistent ? [] : [1n]);
    expect(reconcile.divergenceObservations).toBe(consistent ? 0n : 1n);
  });
}
for (const amount of ['bad', '-0.00', '00.00', '-01.00', '1e2', 'NaN', 'Infinity', '1.001', ' 1.00', '10000000000000000.00', '-10000000000000000.00']) {
  test(`CP04 internal invalid money is sanitized invariant: ${amount}`, async () => {
    const f = reconciliationFixture('0.00', amount); let failure: unknown;
    try { await f.reconcile.execute(f.wallet.id); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PersistenceInvariantError);
    expect(publicHttpError(failure)).toEqual({ status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
    expect(f.reconcile.divergenceObservations).toBe(0n);
  });
}
test('CP04 difference overflow and internal currency mismatch become invariants', async () => {
  const f = reconciliationFixture('9999999999999999.99', '-0.01');
  await expect(f.reconcile.execute(f.wallet.id)).rejects.toBeInstanceOf(PersistenceInvariantError);
  const subtract = spyOn(Money.prototype, 'subtract').mockImplementation(() => { throw new CurrencyMismatchError('internal'); });
  try { const g = reconciliationFixture('0.00', '0.00'); await expect(g.reconcile.execute(g.wallet.id)).rejects.toBeInstanceOf(PersistenceInvariantError); }
  finally { subtract.mockRestore(); }
});
test('CP04 repeated observations are monotonic; logger and metric failures are independent', async () => {
  const f = reconciliationFixture('100.00', '95.00'); const correlationId = crypto.randomUUID();
  const totals: bigint[] = []; const events: unknown[] = [];
  const reconcile = new ReconcileWalletUseCase(f.uow, {
    metric: total => { totals.push(total); throw new Error('metric unavailable'); },
    log: event => { events.push(event); throw new Error('logger unavailable'); },
  });
  for (let i = 0; i < 3; i++) expect((await reconcile.execute(f.wallet.id, { correlationId })).consistent).toBe(false);
  expect(totals).toEqual([1n, 2n, 3n]); expect(reconcile.divergenceObservations).toBe(3n);
  expect(events).toEqual(Array.from({ length: 3 }, () => ({ event: 'WalletReconciliationMismatch', walletId: f.wallet.id, correlationId })));
});
test('CP04 operational effects happen after UoW completion, never on failed commit', async () => {
  const f = reconciliationFixture('100.00', '95.00'); let completed = false; let logged = 0;
  const completedUow: FinancialUnitOfWork = { async run(work, isolation) { const value = await f.uow.run(work, isolation); completed = true; return value; } };
  const reconcile = new ReconcileWalletUseCase(completedUow, { log: () => { expect(completed).toBe(true); logged++; }, metric: () => { expect(completed).toBe(true); } });
  await reconcile.execute(f.wallet.id); expect(logged).toBe(1);
  const failure = Object.assign(new Error('commit failed'), { code: '40001' });
  const failed = new ReconcileWalletUseCase({ async run(work, isolation) { await f.uow.run(work, isolation); throw failure; } }, { log: () => { logged++; } });
  await expect(failed.execute(f.wallet.id)).rejects.toBe(failure); expect(failed.divergenceObservations).toBe(0n); expect(logged).toBe(1);
  expect(publicHttpError(failure).status).toBe(503);
});
test('CP04 missing wallet and unexpected persistence failures retain original mapping', async () => {
  const missing: FinancialUnitOfWork = { async run(work) { return work({ getWallet: async () => undefined } as unknown as FinancialStore); } };
  await expect(new ReconcileWalletUseCase(missing).execute(crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  const failure = new Error('unexpected');
  await expect(new ReconcileWalletUseCase({ async run() { throw failure; } }).execute(crypto.randomUUID())).rejects.toBe(failure);
});
test('CP04 HTTP strict body/query validation precedes UoW and existing errors remain sanitized', async () => {
  let calls = 0; let failure: unknown = new NotFoundError('sensitive');
  const application = await NestFactory.create(AppModule.register({ uow: { async run() { calls++; throw failure; } } }), { logger: false, abortOnError: false });
  try {
    await application.listen(0, '127.0.0.1'); const base = `${await application.getUrl()}/wallets/${crypto.randomUUID()}/reconciliation`;
    const post = (body?: string, query = '') => fetch(base + query, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
    for (const body of ['null', '[]', '1', 'true', '"text"', '{"extra":true}', '{']) expect((await post(body)).status).toBe(400);
    for (const query of ['?limit=1', '?x=', '?x=1&x=2', '?x[]=1']) expect((await post(undefined, query)).status).toBe(400);
    expect((await fetch(base.replace(/wallets\/[^/]+/, 'wallets/invalid'), { method: 'POST' })).status).toBe(400);
    expect(calls).toBe(0);
    for (const [error, status, code] of [[new NotFoundError('secret'), 404, 'WALLET_NOT_FOUND'], [new PersistenceInvariantError('secret'), 500, 'INTERNAL_SERVER_ERROR'], [Object.assign(new Error('secret'), { code: '08006' }), 503, 'SERVICE_UNAVAILABLE'], [new Error('secret'), 500, 'INTERNAL_SERVER_ERROR']] as const) {
      failure = error;
      for (const body of [undefined, '{}']) {
        const response = await post(body); expect(response.status).toBe(status); expect((await response.json() as { code: string }).code).toBe(code);
        expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
      }
    }
    expect(calls).toBe(8);
  } finally { await application.close(); }
});
