import type { FailureCode } from '../modules/wagering/domain/failure-code';
import type { WagerTransactionKind, WagerTransactionStatus } from '../modules/wagering/domain/wager-transaction';
import type { LedgerDirection } from '../modules/wallets/domain/wallet-ledger-entry';

/** Raw SQL bypasses EntitySchema hydration: MikroORM's pg parser preserves timestamps as text. */
type PostgresValue<T> = T extends Date ? Date | string : T;
export type PostgresRow<T> = { [K in keyof T]: PostgresValue<T[K]> };

export interface WalletRecord {
  id: string; player_id: string; currency: string; balance: string; version: number; created_at: Date; updated_at: Date;
}
export interface WagerRecord {
  id: string; provider_id: string; external_transaction_id: string; idempotency_key: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string; kind: WagerTransactionKind;
  amount: string; currency: string; reference_external_transaction_id: string | null; reference_transaction_id: string | null;
  status: WagerTransactionStatus; failure_code: FailureCode | null; recorded_balance_amount: string | null;
  recorded_balance_currency: string | null; attempts: number; next_retry_at: Date | null; expires_at: Date | null;
  created_at: Date; processed_at: Date | null;
}
export interface LedgerRecord {
  id: string; wallet_id: string; transaction_id: string; direction: LedgerDirection; amount: string; currency: string;
  balance_before: string; balance_after: string; created_at: Date;
}
export interface InboxRecord {
  consumer_name: string; message_id: string; payload_hash: string; received_at: Date; processed_at: Date | null;
}
export interface OutboxRecord {
  id: string; aggregate_id: string; event_type: string; payload: Readonly<Record<string, unknown>>; occurred_at: Date;
  attempts: number; next_attempt_at: Date; lease_owner: string | null; lease_token: string | null;
  lease_until: Date | null; published_at: Date | null; last_error: string | null;
}
