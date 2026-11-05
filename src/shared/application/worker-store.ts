import type { WagerTransaction } from '../../modules/wagering/domain/wager-transaction';
import type { OutboxMessage, RetryPolicy } from '../../modules/messaging/domain/outbox-message';

export interface OutboxClaim {
  readonly message: OutboxMessage;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
}
/** Persistence primitives only; callers use FinancialUnitOfWork and wallet-first locking. */
export interface WorkerStore {
  /** Nonlocking discovery; state/due time must be rechecked after Wallet -> Wager locks. */
  findDuePendingWagers(now: Date, limit: number): Promise<WagerTransaction[]>;
  /** Updates mutable fields only, conditional on persisted PENDING_REFERENCE; false means stale work. */
  updatePendingWager(transaction: WagerTransaction): Promise<boolean>;
  /** Commit claim before contacting SQS. A fresh token is required for every claim. */
  claimNextOutbox(workerId: string, leaseToken: string, now: Date, leaseUntil: Date, retry?: RetryPolicy): Promise<OutboxClaim | undefined>;
  completeOutbox(id: string, workerId: string, leaseToken: string, publishedAt: Date): Promise<boolean>;
  /** message must already have scheduleRetry(now) applied; lastError is a safe diagnostic code, not raw errors. */
  failOutbox(message: OutboxMessage, workerId: string, leaseToken: string, now: Date, lastError: string): Promise<boolean>;
}
