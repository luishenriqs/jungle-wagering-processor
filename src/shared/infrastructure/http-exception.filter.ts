import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ConflictError, NotFoundError, PersistenceInvariantError, RetryExhaustedError, WagerNotFoundError, sqlError } from '../application/application-errors';
import { isTransient } from '../application/execution';
import { CurrencyMismatchError, IdempotencyConflictError, InvalidDomainInputError, InvalidMoneyError, MoneyOverflowError } from '../domain/domain-errors';

export function publicHttpError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    // Preserve native HTTP status semantics without copying arbitrary exception messages.
    const known: Record<number, [string, string]> = { 400: ['BAD_REQUEST', 'Bad request'], 401: ['UNAUTHORIZED', 'Unauthorized'],
      403: ['FORBIDDEN', 'Forbidden'], 404: ['NOT_FOUND', 'Not found'], 405: ['METHOD_NOT_ALLOWED', 'Method not allowed'],
      409: ['CONFLICT', 'Conflict'], 413: ['PAYLOAD_TOO_LARGE', 'Payload too large'], 415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type'],
      429: ['TOO_MANY_REQUESTS', 'Too many requests'], 503: ['SERVICE_UNAVAILABLE', 'Service unavailable'] };
    const [code, message] = known[status] ?? ['HTTP_ERROR', 'HTTP request failed'];
    return { status, code, message };
  }
  if (error instanceof InvalidDomainInputError) return { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' };
  if (error instanceof InvalidMoneyError) return { status: 400, code: 'INVALID_MONEY', message: 'Invalid money' };
  if (error instanceof MoneyOverflowError) return { status: 400, code: 'MONEY_OVERFLOW', message: 'Money exceeds supported range' };
  if (error instanceof CurrencyMismatchError) return { status: 400, code: 'CURRENCY_MISMATCH', message: 'Currencies must match' };
  if (error instanceof WagerNotFoundError) return { status: 404, code: 'WAGER_NOT_FOUND', message: 'Wager transaction not found' };
  if (error instanceof NotFoundError) return { status: 404, code: 'WALLET_NOT_FOUND', message: 'Wallet not found' };
  if (error instanceof ConflictError) return { status: 409, code: 'WALLET_ALREADY_EXISTS', message: 'Wallet already exists for player and currency' };
  if (error instanceof IdempotencyConflictError) return { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency conflict' };
  if (!(error instanceof PersistenceInvariantError)) {
    const code = sqlError(error).code ?? '';
    if (error instanceof RetryExhaustedError || isTransient(error) || /^08[A-Z0-9]{3}$/.test(code)
      || ['57P01', '57P02', '57P03', '53300', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) {
      return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' };
    }
  }
  return { status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' };
}
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<{ status(value: number): { json(body: unknown): void }; setHeader(key: string, value: string): void }>();
    const request = http.getRequest<{ correlationId?: string }>();
    if (request.correlationId) response.setHeader('x-correlation-id', request.correlationId);
    const { status, ...body } = publicHttpError(error);
    response.status(status).json(body);
  }
}
