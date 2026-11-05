import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { spyOn } from 'bun:test';
import { AppModule } from '../../src/app.module';

const valid = { providerId: 'provider-test', externalTransactionId: 'external-test', playerId: 'player-test-01',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', roundId: 'round-test', gameId: 'game-test', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };

test('valid HTTP wager without available persistence returns 503 instead of a missing route', async () => {
  const app = await NestFactory.create(AppModule.register({ uow: { async run() { throw new ServiceUnavailableException(); } } }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/wagering/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'provider-test:external-test' }, body: JSON.stringify(valid) });
    expect(response.status).toBe(503);
  } finally { await app.close(); }
});

test('HTTP wager rejects missing idempotency header before persistence', async () => {
  let calls = 0;
  const app = await NestFactory.create(AppModule.register({ uow: { async run() { calls++; throw new Error('must not reach persistence'); } } }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/wagering/transactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid) });
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  } finally { await app.close(); }
});

import { request as httpRequest } from 'node:http';
import { idempotencyKey, wagerHttpInput, wagerHttpStatus } from '../../src/modules/wagering/infrastructure/wager-http.dto';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wager-transaction';
import type { ProcessWagerResult } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { wagerRequest } from '../../src/modules/messaging/application/wager-request';
import { canonicalWagerPayload, wagerPayloadHash } from '../../src/modules/wagering/application/wager-payload';
import { PersistenceInvariantError } from '../../src/shared/application/application-errors';

const metadata = { headers: { 'idempotency-key': 'provider-test:external-test' }, rawHeaders: ['Idempotency-Key', 'provider-test:external-test'], correlationId: crypto.randomUUID() };
const invalidHeaders = [undefined, null, '', ' ', ' key', 'key ', ['key'], 3, {}, true];
for (const [index, value] of invalidHeaders.entries()) {
  test(`invalid idempotency header ${index} is rejected`, () => {
    expect(() => idempotencyKey({ headers: { 'idempotency-key': value } })).toThrow();
  });
}
for (const rawHeaders of [[], ['Idempotency-Key'], ['Idempotency-Key', 'key', 'IDEMPOTENCY-KEY', 'key'], ['Idempotency-Key', 'other']]) {
  test(`raw header occurrences are authoritative: ${JSON.stringify(rawHeaders)}`, () => {
    expect(() => idempotencyKey({ headers: { 'idempotency-key': 'key' }, rawHeaders })).toThrow();
  });
}
test('one mixed-case header is valid and identity does not come from body', () => {
  expect(idempotencyKey({ headers: { 'idempotency-key': 'key' }, rawHeaders: ['iDeMpOtEnCy-KeY', 'key'] })).toBe('key');
  expect(() => wagerHttpInput({ ...valid, idempotencyKey: 'body-key' }, metadata)).toThrow();
});
const invalidBodies: unknown[] = [null, [], 1, 'string', {}, { ...valid, extra: true }, { ...valid, money: null }, { ...valid, money: [] },
  { ...valid, money: { ...valid.money, extra: true } }, { ...valid, walletId: 'invalid' }, { ...valid, kind: 'OPENING' }, { ...valid, kind: 'OTHER' },
  { ...valid, providerId: 'SYSTEM' }, { ...valid, money: { amount: '0.00', currency: 'BRL' } },
  ...['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'].flatMap(key =>
    [undefined, null, [], {}, 1, '', ' '].map(value => ({ ...valid, [key]: value }))),
  ...[25, NaN, Infinity, 'NaN', 'Infinity', '1e2', '1.001', '-1.00', '1', '10000000000000000.00'].map(amount => ({ ...valid, money: { amount, currency: 'BRL' } })),
  ...['ZZZ', 'brl', '', null, 1].map(currency => ({ ...valid, money: { amount: '1.00', currency } })),
  ...['', ' ', 1, [], {}].map(referenceExternalTransactionId => ({ ...valid, kind: 'WIN', referenceExternalTransactionId })),
  ...['BET', 'LOSS'].map(kind => ({ ...valid, kind, referenceExternalTransactionId: 'bet-ref' })),
  ...['REFUND', 'ROLLBACK'].flatMap(kind => [undefined, null].map(referenceExternalTransactionId => ({ ...valid, kind, referenceExternalTransactionId }))),
  { ...valid, kind: 'WIN', referenceExternalTransactionId: valid.externalTransactionId }];
for (const [index, body] of invalidBodies.entries()) {
  test(`strict wager body rejects case ${index}`, () => expect(() => wagerHttpInput(body, metadata)).toThrow());
}
for (const kind of [K.Bet, K.Win, K.Loss, K.Refund, K.Rollback]) {
  for (const reference of [undefined, null, 'reference-bet']) {
    if ((kind === K.Bet || kind === K.Loss) && reference != null || (kind === K.Refund || kind === K.Rollback) && reference == null) continue;
    test(`HTTP/SQS share canonical payload and hash: ${kind}, reference ${reference}`, () => {
      const body = { ...valid, kind, walletId: valid.walletId.toUpperCase(), referenceExternalTransactionId: reference };
      const http = wagerHttpInput(body, metadata);
      const sqs = wagerRequest(JSON.stringify({ type: 'WagerTransactionRequested', messageId: crypto.randomUUID(), occurredAt: new Date().toISOString(),
        data: { ...body, idempotencyKey: http.idempotencyKey } }), 'test-consumer', { now: () => new Date() });
      expect(canonicalWagerPayload(http)).toBe(canonicalWagerPayload(sqs));
      expect(wagerPayloadHash(http)).toBe(wagerPayloadHash(sqs));
      expect(wagerPayloadHash({ ...http, idempotencyKey: 'different-key' } as typeof http)).toBe(wagerPayloadHash(http));
      if (reference == null) expect(Object.hasOwn(http, 'referenceExternalTransactionId')).toBe(false);
      else expect(http.referenceExternalTransactionId).toBe(reference);
      expect(http.playerId).toBe('player-test-01');
    });
  }
}
for (const [status, expected] of [[S.Processed, 200], [S.PendingReference, 202], [S.Rejected, 422], [S.Failed, 422]] as const) {
  test(`result status ${status} has explicit HTTP ${expected}`, () => {
    const result: ProcessWagerResult = { transactionId: crypto.randomUUID(), status, idempotentReplay: true, balance: { amount: '90.00', currency: 'BRL' } };
    expect(wagerHttpStatus(result)).toBe(expected);
    if (status !== S.Failed) expect(wagerHttpStatus({ ...result, idempotentReplay: false })).toBe(expected);
  });
}
test('uncommitted PENDING and nonhistorical FAILED are internal inconsistencies', () => {
  for (const status of [S.Pending, S.Failed, 'UNKNOWN' as S]) {
    expect(() => wagerHttpStatus({ transactionId: crypto.randomUUID(), status, idempotentReplay: false, balance: valid.money })).toThrow(PersistenceInvariantError);
  }
});
test('HTTP invalid contracts and real duplicate headers never reach the UoW; filter/correlation remain active', async () => {
  let calls = 0;
  const app = await NestFactory.create(AppModule.register({ uow: { async run() { calls++; throw new Error('private SQL credentials'); } } }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/wagering/transactions`;
    for (const body of invalidBodies) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key' }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
    const malformed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    const duplicate = await new Promise<number>(resolve => {
      const req = httpRequest(url, { method: 'POST', headers: ['Content-Type', 'application/json', 'Idempotency-Key', 'key', 'iDeMpOtEnCy-KeY', 'key'] }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!));
      });
      req.end(JSON.stringify(valid));
    });
    expect(duplicate).toBe(400);
    expect(calls).toBe(0);
    const failed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key' }, body: JSON.stringify(valid) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
  } finally { await app.close(); }
});

test('default HTTP composition without DATABASE_URL has no ORM initialization and both financial endpoints return 503', async () => {
  const previous = process.env['DATABASE_URL']; delete process.env['DATABASE_URL'];
  const init = spyOn(MikroORM, 'init');
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false }); await app.listen(0, '127.0.0.1');
    expect((await fetch(await app.getUrl())).status).toBe(404);
    for (const [path, payload] of [['/wallets', { playerId: 'player-test', initialBalance: valid.money }], ['/wagering/transactions', valid]] as const) {
      const response = await fetch(`${await app.getUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key' }, body: JSON.stringify(payload) });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' });
      expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(init).toHaveBeenCalledTimes(0);
  } finally {
    await app?.close(); init.mockRestore();
    if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous;
  }
});

import type { FinancialStore } from '../../src/shared/application/financial-store';

for (const path of [`/wagering/transactions/${valid.walletId}`, '/providers/provider-test/wagering/transactions/external-test']) {
  test(`CP03 absent transaction GET ${path} uses WAGER_NOT_FOUND envelope`, async () => {
    const store = { async getWager() { return undefined; }, async findWager() { return undefined; } } as unknown as FinancialStore;
    const app = await NestFactory.create(AppModule.register({ uow: { run: work => work(store) } }), { logger: false, abortOnError: false });
    try {
      await app.listen(0, '127.0.0.1');
      const response = await fetch(`${await app.getUrl()}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'WAGER_NOT_FOUND', message: 'Wager transaction not found' });
    } finally { await app.close(); }
  });
}

import { WagerNotFoundError, NotFoundError } from '../../src/shared/application/application-errors';
import { publicHttpError } from '../../src/shared/infrastructure/http-exception.filter';
import { toWagerHttpResponse, wagerQueryText } from '../../src/modules/wagering/infrastructure/wager-http.dto';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../src/shared/domain/money';

for (const value of [undefined, null, 1, [], {}, '', ' ', ' provider', 'provider ', '\tprovider', 'provider\n']) {
  test(`CP03 external query identifier rejects ${JSON.stringify(value)}`, () => expect(() => wagerQueryText(value)).toThrow());
}
test('CP03 query projection includes exact public fields and nulls, including PENDING and OPENING', () => {
  expect(wagerQueryText('SYSTEM')).toBe('SYSTEM'); expect(wagerQueryText('external:test-01')).toBe('external:test-01');
  const createdAt = new Date('2026-11-05T12:00:00.123Z');
  const state = { ...valid, id: valid.walletId, kind: K.Bet, money: Money.from(valid.money), idempotencyKey: 'private-key', payloadHash: 'a'.repeat(64),
    status: S.Pending, createdAt, attempts: 9, nextRetryAt: createdAt, expiresAt: createdAt };
  const expected = { transactionId: state.id, providerId: state.providerId, externalTransactionId: state.externalTransactionId, walletId: state.walletId,
    playerId: state.playerId, roundId: state.roundId, gameId: state.gameId, kind: K.Bet, money: valid.money, status: S.Pending, createdAt: createdAt.toISOString(),
    recordedBalance: null, referenceExternalTransactionId: null, referenceTransactionId: null, failureCode: null, processedAt: null };
  expect(toWagerHttpResponse(WagerTransaction.rehydrate(state))).toEqual(expected);
  expect(toWagerHttpResponse(WagerTransaction.rehydrate({ ...state, kind: K.Opening, providerId: 'SYSTEM' }))).toEqual({ ...expected, kind: K.Opening, providerId: 'SYSTEM' });
});
test('CP03 WagerNotFoundError preserves hierarchy and sanitized resource mapping', () => {
  const error = new WagerNotFoundError('private SQL connection details');
  expect(error).toBeInstanceOf(NotFoundError);
  expect(publicHttpError(error)).toEqual({ status: 404, code: 'WAGER_NOT_FOUND', message: 'Wager transaction not found' });
  expect(publicHttpError(new NotFoundError('Wager transaction not found'))).toEqual({ status: 404, code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });
});
test('CP03 invalid query path identifiers are 400 before UoW; unexpected query errors retain sanitization', async () => {
  let calls = 0;
  const app = await NestFactory.create(AppModule.register({ uow: { async run() { calls++; throw new Error('private credentials SQL'); } } }), { logger: false, abortOnError: false });
  try {
    await app.listen(0, '127.0.0.1'); const url = await app.getUrl();
    for (const path of ['/wagering/transactions/invalid', '/wagering/transactions/%20', '/providers/%20/wagering/transactions/key',
      '/providers/%20provider/wagering/transactions/key', '/providers/provider%20/wagering/transactions/key',
      '/providers/provider/wagering/transactions/%20', '/providers/provider/wagering/transactions/%20key', '/providers/provider/wagering/transactions/key%20']) {
      expect((await fetch(`${url}${path}`)).status).toBe(400);
    }
    expect(calls).toBe(0);
    for (const path of [`/wagering/transactions/${valid.walletId}`, '/providers/provider-test/wagering/transactions/external-test']) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(500); expect(await response.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
      expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
  } finally { await app.close(); }
});
