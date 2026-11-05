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

import { HttpException, BadRequestException, NotFoundException } from '@nestjs/common';
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
