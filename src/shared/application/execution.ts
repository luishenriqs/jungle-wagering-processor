import { randomUUID } from 'node:crypto';
import { sqlError, RetryExhaustedError } from './application-errors';
import { internalId } from './identifiers';

export type Checkpoint = 'wallet' | 'wager' | 'ledger' | 'outbox' | 'inbox' | 'beforeCommit';
export interface ExecutionOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Internal fault-injection seam; never populated from an HTTP/SQS payload. */
  readonly checkpoint?: (phase: Checkpoint) => Promise<void>;
  readonly maxAttempts?: number;
}
export function execution(options: ExecutionOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('maxAttempts must be 1..10');
  return { now: options.now ?? (() => new Date()), newId: () => internalId((options.newId ?? randomUUID)()),
    checkpoint: options.checkpoint ?? (async (_phase: Checkpoint) => {}), maxAttempts };
}
export function isTransient(error: unknown): boolean {
  return ['40P01', '40001', '55P03', '57014'].includes(sqlError(error).code ?? '');
}
export async function retryDelay(attempt: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.min(250, 25 * 2 ** attempt)));
}
export function exhausted(error: unknown): RetryExhaustedError { return new RetryExhaustedError('Transaction retry limit reached', { cause: error }); }
