import { Money } from '../shared/domain/money';
import { Wallet } from '../modules/wallets/domain/wallet';
import { WalletLedgerEntry } from '../modules/wallets/domain/wallet-ledger-entry';
import { WagerTransaction } from '../modules/wagering/domain/wager-transaction';
import { InboxMessage } from '../modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../modules/messaging/domain/outbox-message';
import type { WalletRecord, WagerRecord, LedgerRecord, InboxRecord, OutboxRecord, PostgresRow } from './records';
import { databaseTimestamp, nullableDatabaseTimestamp } from './timestamps';

export const walletRecord = (w: Wallet): WalletRecord => ({ id: w.id, player_id: w.playerId, currency: w.currency,
  balance: w.balance.toString(), version: w.version, created_at: w.createdAt, updated_at: w.updatedAt });
export const walletDomain = (r: PostgresRow<WalletRecord>): Wallet => Wallet.rehydrate({ id: r.id, playerId: r.player_id,
  currency: r.currency, balance: Money.from({ amount: r.balance, currency: r.currency }), version: r.version,
  createdAt: databaseTimestamp(r.created_at, 'wallets.created_at'), updatedAt: databaseTimestamp(r.updated_at, 'wallets.updated_at') });
export const wagerRecord = (t: WagerTransaction): WagerRecord => ({ id: t.id, provider_id: t.providerId,
  external_transaction_id: t.externalTransactionId, idempotency_key: t.idempotencyKey, payload_hash: t.payloadHash,
  wallet_id: t.walletId, player_id: t.playerId, round_id: t.roundId, game_id: t.gameId, kind: t.kind, amount: t.money.toString(),
  currency: t.money.currency, reference_external_transaction_id: t.referenceExternalTransactionId ?? null,
  reference_transaction_id: t.referenceTransactionId ?? null, status: t.status, failure_code: t.failureCode ?? null,
  recorded_balance_amount: t.recordedBalance?.toString() ?? null, recorded_balance_currency: t.recordedBalance?.currency ?? null,
  attempts: t.attempts, next_retry_at: t.nextRetryAt ?? null, expires_at: t.expiresAt ?? null, created_at: t.createdAt, processed_at: t.processedAt ?? null });
export const wagerDomain = (r: PostgresRow<WagerRecord>): WagerTransaction => WagerTransaction.rehydrate({ id: r.id,
  providerId: r.provider_id, externalTransactionId: r.external_transaction_id, idempotencyKey: r.idempotency_key, payloadHash: r.payload_hash,
  walletId: r.wallet_id, playerId: r.player_id, roundId: r.round_id, gameId: r.game_id, kind: r.kind,
  money: Money.from({ amount: r.amount, currency: r.currency }), referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
  referenceTransactionId: r.reference_transaction_id ?? undefined, status: r.status, failureCode: r.failure_code ?? undefined,
  recordedBalance: r.recorded_balance_amount === null ? undefined : Money.from({ amount: r.recorded_balance_amount, currency: r.recorded_balance_currency ?? r.currency }),
  attempts: r.attempts, nextRetryAt: nullableDatabaseTimestamp(r.next_retry_at, 'wager_transactions.next_retry_at'),
  expiresAt: nullableDatabaseTimestamp(r.expires_at, 'wager_transactions.expires_at'),
  createdAt: databaseTimestamp(r.created_at, 'wager_transactions.created_at'),
  processedAt: nullableDatabaseTimestamp(r.processed_at, 'wager_transactions.processed_at') });
export const ledgerRecord = (e: WalletLedgerEntry): LedgerRecord => ({ id: e.id, wallet_id: e.walletId, transaction_id: e.transactionId,
  direction: e.direction, amount: e.money.toString(), currency: e.money.currency, balance_before: e.balanceBefore.toString(), balance_after: e.balanceAfter.toString(), created_at: e.createdAt });
export const ledgerDomain = (r: PostgresRow<LedgerRecord>): WalletLedgerEntry => WalletLedgerEntry.rehydrate({ id: r.id, walletId: r.wallet_id,
  transactionId: r.transaction_id, direction: r.direction, money: Money.from({ amount: r.amount, currency: r.currency }),
  balanceBefore: Money.from({ amount: r.balance_before, currency: r.currency }), balanceAfter: Money.from({ amount: r.balance_after, currency: r.currency }),
  createdAt: databaseTimestamp(r.created_at, 'wallet_ledger_entries.created_at') });
export const inboxDomain = (r: PostgresRow<InboxRecord>): InboxMessage => InboxMessage.rehydrate({ consumerName: r.consumer_name,
  messageId: r.message_id, payloadHash: r.payload_hash, receivedAt: databaseTimestamp(r.received_at, 'inbox_messages.received_at'),
  processedAt: nullableDatabaseTimestamp(r.processed_at, 'inbox_messages.processed_at') });
export const outboxRecord = (m: OutboxMessage): OutboxRecord => ({ id: m.id, aggregate_id: m.aggregateId, event_type: m.eventType,
  payload: m.payload, occurred_at: m.occurredAt, attempts: m.attempts, next_attempt_at: m.nextAttemptAt,
  lease_owner: null, lease_token: null, lease_until: null, published_at: m.publishedAt ?? null, last_error: null });
export const outboxDomain = (r: PostgresRow<OutboxRecord>): OutboxMessage => OutboxMessage.rehydrate({ id: r.id, aggregateId: r.aggregate_id,
  eventType: r.event_type, payload: r.payload, occurredAt: databaseTimestamp(r.occurred_at, 'outbox_messages.occurred_at'), attempts: r.attempts,
  nextAttemptAt: databaseTimestamp(r.next_attempt_at, 'outbox_messages.next_attempt_at'),
  publishedAt: nullableDatabaseTimestamp(r.published_at, 'outbox_messages.published_at') });
