import { IdempotencyConflictError, InvalidDomainInputError, InvalidMoneyError, MoneyOverflowError } from '../../../shared/domain/domain-errors';
import { NotFoundError, sqlError } from '../../../shared/application/application-errors';
export interface ConsumerFailure { readonly kind: 'permanent' | 'transient' | 'unknown'; readonly code: string }
export function classifyConsumerError(error: unknown): ConsumerFailure {
  if (error instanceof IdempotencyConflictError) return { kind: 'permanent', code: 'IDEMPOTENCY_CONFLICT' };
  if (error instanceof MoneyOverflowError) return { kind: 'permanent', code: 'MONEY_OVERFLOW' };
  if (error instanceof InvalidMoneyError) return { kind: 'permanent', code: 'INVALID_MONEY' };
  if (error instanceof InvalidDomainInputError) return { kind: 'permanent', code: 'INVALID_INPUT' };
  if (error instanceof NotFoundError) return { kind: 'permanent', code: 'WALLET_NOT_FOUND' };
  const code = sqlError(error).code ?? '';
  if (['40P01', '40001', '55P03', '57014', '57P01', '57P02', '57P03', '53300'].includes(code) || code.startsWith('08')) {
    return { kind: 'transient', code: 'POSTGRES_TRANSIENT' };
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
    return { kind: 'transient', code: 'NETWORK_ERROR' };
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return { kind: 'transient', code: 'TIMEOUT' };
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
    if (['TimeoutError', 'RequestTimeout', 'AbortError'].includes(String(e.name))) return { kind: 'transient', code: 'TIMEOUT' };
    if (['ThrottlingException', 'RequestThrottled', 'ServiceUnavailable'].includes(String(e.name)) || (e.$metadata?.httpStatusCode ?? 0) >= 500) {
      return { kind: 'transient', code: 'SQS_TRANSIENT' };
    }
  }
  return { kind: 'unknown', code: 'UNKNOWN_ERROR' };
}
