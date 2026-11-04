import { EntitySchema } from '@mikro-orm/core';
import { ExactNumericType } from './exact-numeric-type';
import type { InboxRecord, LedgerRecord, OutboxRecord, WagerRecord, WalletRecord } from './records';

const uuid = { type: 'uuid' } as const;
const text = { type: 'string', columnType: 'text' } as const;
const date = { type: Date, columnType: 'timestamptz' } as const;
const numeric = { type: ExactNumericType } as const;
export const WalletSchema = new EntitySchema<WalletRecord>({ name: 'WalletRecord', tableName: 'wallets', properties: {
  id: { ...uuid, primary: true }, player_id: text, currency: { type: 'string', length: 3 }, balance: numeric,
  version: { type: 'integer' }, created_at: date, updated_at: date,
} });
export const WagerSchema = new EntitySchema<WagerRecord>({ name: 'WagerRecord', tableName: 'wager_transactions', properties: {
  id: { ...uuid, primary: true }, provider_id: text, external_transaction_id: text, idempotency_key: text,
  payload_hash: { type: 'string', columnType: 'char(64)' }, wallet_id: uuid, player_id: text, round_id: text, game_id: text,
  kind: text, amount: numeric, currency: { type: 'string', length: 3 }, reference_external_transaction_id: { ...text, nullable: true },
  reference_transaction_id: { ...uuid, nullable: true }, status: text, failure_code: { ...text, nullable: true },
  recorded_balance_amount: { ...numeric, nullable: true }, recorded_balance_currency: { type: 'string', length: 3, nullable: true },
  attempts: { type: 'integer' }, next_retry_at: { ...date, nullable: true }, expires_at: { ...date, nullable: true },
  created_at: date, processed_at: { ...date, nullable: true },
} });
export const LedgerSchema = new EntitySchema<LedgerRecord>({ name: 'LedgerRecord', tableName: 'wallet_ledger_entries', properties: {
  id: { ...uuid, primary: true }, wallet_id: uuid, transaction_id: uuid, direction: text, amount: numeric,
  currency: { type: 'string', length: 3 }, balance_before: numeric, balance_after: numeric, created_at: date,
} });
export const InboxSchema = new EntitySchema<InboxRecord>({ name: 'InboxRecord', tableName: 'inbox_messages', properties: {
  consumer_name: { ...text, primary: true }, message_id: { ...text, primary: true }, payload_hash: { type: 'string', columnType: 'char(64)' },
  received_at: date, processed_at: { ...date, nullable: true },
} });
export const OutboxSchema = new EntitySchema<OutboxRecord>({ name: 'OutboxRecord', tableName: 'outbox_messages', properties: {
  id: { ...uuid, primary: true }, aggregate_id: uuid, event_type: text, payload: { type: 'json', columnType: 'jsonb' }, occurred_at: date,
  attempts: { type: 'integer' }, next_attempt_at: date, lease_owner: { ...text, nullable: true }, lease_token: { ...uuid, nullable: true },
  lease_until: { ...date, nullable: true }, published_at: { ...date, nullable: true }, last_error: { ...text, nullable: true },
} });
export const entities = [WalletSchema, WagerSchema, LedgerSchema, InboxSchema, OutboxSchema];
