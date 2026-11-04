import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/database/config';
import { PersistenceInvariantError } from '../../src/shared/application/application-errors';
import { dateCopy } from '../../src/shared/domain/validation';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { walletDomain, walletRecord, wagerDomain, wagerRecord, ledgerDomain, ledgerRecord, inboxDomain, outboxDomain } from '../../src/database/mappers';
import type { InboxRecord, OutboxRecord } from '../../src/database/records';
import { at, m, createTransactionProps } from '../fixtures';

let orm: MikroORM;
let parseTimestamp: (value: string) => string;
beforeAll(async () => {
  // Exercise the installed driver's actual OID parser, without a PostgreSQL connection or stub.
  orm = await MikroORM.init({ ...databaseConfig('postgresql://unused@127.0.0.1/jungle_test'), connect: false, logger: () => {} });
  const settings = orm.em.getConnection().getKnex().client.connectionSettings as {
    types: { getTypeParser(oid: number, format: string): (value: string) => unknown };
  };
  const parser = settings.types.getTypeParser(1184, 'text');
  parseTimestamp = value => {
    const parsed = parser(value);
    if (typeof parsed !== 'string') throw new Error('Expected the installed MikroORM timestamp parser to return text');
    return parsed;
  };
});
afterAll(async () => { if (orm) await orm.close(true); });

const wallet = () => Wallet.open({ id: 'wallet', playerId: 'player-test-01', initialBalance: m('10.00'), at,
  opening: { transactionId: 'opening', ledgerEntryId: 'entry' } });
const wager = () => wagerRecord(WagerTransaction.create(createTransactionProps()));
const inbox = (): InboxRecord => ({ consumer_name: 'consumer', message_id: 'message', payload_hash: 'a'.repeat(64), received_at: at, processed_at: null });
const outbox = (): OutboxRecord => ({ id: 'event', aggregate_id: 'wallet', event_type: 'TestEvent', payload: {}, occurred_at: at,
  attempts: 0, next_attempt_at: at, lease_owner: null, lease_token: null, lease_until: null, published_at: null, last_error: null });
const wire = '2026-11-04 12:00:00.123456+00';
const expected = '2026-11-04T12:00:00.123Z';

test('real pg timestamp text reproduces Wallet failure and is normalized before rehydrate', () => {
  const value = parseTimestamp(wire);
  expect(typeof value).toBe('string');
  // @ts-expect-error Domain intentionally rejects a timestamp string.
  expect(() => dateCopy(value)).toThrow('A valid date is required');
  const row = walletRecord(wallet());
  Reflect.set(row, 'created_at', value); Reflect.set(row, 'updated_at', value);
  const restored = walletDomain(row);
  expect(restored.createdAt).toBeInstanceOf(Date);
  expect(restored.createdAt.toISOString()).toBe(expected);
  expect(restored.updatedAt.toISOString()).toBe(expected);
  expect(restored.balance.toString()).toBe('10.00');
  expect(restored.version).toBe(1);
});
test('Wager normalizes all four timestamps without executing state transitions', () => {
  const row = wager();
  for (const field of ['created_at', 'processed_at', 'next_retry_at', 'expires_at']) Reflect.set(row, field, parseTimestamp(wire));
  const restored = wagerDomain(row);
  for (const value of [restored.createdAt, restored.processedAt, restored.nextRetryAt, restored.expiresAt]) expect(value?.toISOString()).toBe(expected);
  expect(restored.status).toBe(row.status);
  expect(restored.attempts).toBe(row.attempts);
});
test('Ledger, Inbox and Outbox normalize every timestamp used by their domain mappers', () => {
  const entry = ledgerRecord(wallet().openingEntry!);
  Reflect.set(entry, 'created_at', parseTimestamp(wire));
  expect(ledgerDomain(entry).createdAt.toISOString()).toBe(expected);
  const received = inbox();
  for (const field of ['received_at', 'processed_at']) Reflect.set(received, field, parseTimestamp(wire));
  const restoredInbox = inboxDomain(received);
  expect(restoredInbox.receivedAt.toISOString()).toBe(expected);
  expect(restoredInbox.processedAt?.toISOString()).toBe(expected);
  const queued = outbox();
  for (const field of ['occurred_at', 'next_attempt_at', 'published_at']) Reflect.set(queued, field, parseTimestamp(wire));
  const restoredOutbox = outboxDomain(queued);
  expect(restoredOutbox.occurredAt.toISOString()).toBe(expected);
  expect(restoredOutbox.nextAttemptAt.toISOString()).toBe(expected);
  expect(restoredOutbox.publishedAt?.toISOString()).toBe(expected);
});
test.each([
  ['2026-11-04 09:00:00.123456-03', expected],
  ['2026-11-04 17:30:00.123456+05:30', expected],
  ['2026-11-04T17:30:00.123456+0530', expected],
  ['2026-11-04T12:00:00Z', '2026-11-04T12:00:00.000Z'],
])('timezone conversion %s', (value, utc) => {
  const row = walletRecord(wallet()); Reflect.set(row, 'created_at', parseTimestamp(value));
  expect(walletDomain(row).createdAt.toISOString()).toBe(utc);
});
test('valid Date values remain supported and defensive copies are preserved', () => {
  const row = walletRecord(wallet()); const date = new Date(at);
  row.created_at = date; row.updated_at = date;
  const restored = walletDomain(row);
  date.setUTCFullYear(2000); restored.updatedAt.setUTCFullYear(2001);
  expect(restored.createdAt.toISOString()).toBe(at.toISOString());
  expect(restored.updatedAt.toISOString()).toBe(at.toISOString());
});
test('nullable timestamps remain absent rather than becoming epoch or Invalid Date', () => {
  const restored = wagerDomain(wager());
  expect(restored.processedAt).toBeUndefined(); expect(restored.nextRetryAt).toBeUndefined(); expect(restored.expiresAt).toBeUndefined();
  expect(inboxDomain(inbox()).processedAt).toBeUndefined();
  expect(outboxDomain(outbox()).publishedAt).toBeUndefined();
});

function replaceField<T extends object>(row: T, field: keyof T, value: unknown): T { Reflect.set(row, field, value); return row; }
// Required and nullable fields are each checked; null is valid only in nullable columns.
const columns = [
  { name: 'wallets.created_at', nullable: false, read: (v: unknown) => walletDomain(replaceField(walletRecord(wallet()), 'created_at', v)) },
  { name: 'wallets.updated_at', nullable: false, read: (v: unknown) => walletDomain(replaceField(walletRecord(wallet()), 'updated_at', v)) },
  { name: 'wager_transactions.created_at', nullable: false, read: (v: unknown) => wagerDomain(replaceField(wager(), 'created_at', v)) },
  ...(['processed_at', 'next_retry_at', 'expires_at'] as const).map(field => ({ name: `wager_transactions.${field}`, nullable: true, read: (v: unknown) => wagerDomain(replaceField(wager(), field, v)) })),
  { name: 'wallet_ledger_entries.created_at', nullable: false, read: (v: unknown) => ledgerDomain(replaceField(ledgerRecord(wallet().openingEntry!), 'created_at', v)) },
  { name: 'inbox_messages.received_at', nullable: false, read: (v: unknown) => inboxDomain(replaceField(inbox(), 'received_at', v)) },
  { name: 'inbox_messages.processed_at', nullable: true, read: (v: unknown) => inboxDomain(replaceField(inbox(), 'processed_at', v)) },
  { name: 'outbox_messages.occurred_at', nullable: false, read: (v: unknown) => outboxDomain(replaceField(outbox(), 'occurred_at', v)) },
  { name: 'outbox_messages.next_attempt_at', nullable: false, read: (v: unknown) => outboxDomain(replaceField(outbox(), 'next_attempt_at', v)) },
  { name: 'outbox_messages.published_at', nullable: true, read: (v: unknown) => outboxDomain(replaceField(outbox(), 'published_at', v)) },
];
test.each(columns)('rejects corrupt values at the persistence boundary: $name', ({ name, nullable, read }) => {
  const bad: unknown[] = [undefined, '', 'not-a-date', 'Infinity', '-infinity', 0, NaN, {}, new Date('invalid'),
    '2026-02-30 12:00:00+00', '2026-11-04 25:00:00+00', '2026-11-04 12:00:00', '2026-11-04 12:00:00+99'];
  if (!nullable) bad.push(null);
  for (const value of bad) {
    expect(() => read(value)).toThrow(PersistenceInvariantError);
    expect(() => read(value)).toThrow(name);
  }
});
