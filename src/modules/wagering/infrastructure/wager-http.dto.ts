import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { PersistenceInvariantError } from '../../../shared/application/application-errors';
import { internalId } from '../../../shared/application/identifiers';
import { requireText } from '../../../shared/domain/validation';
import { Money } from '../../../shared/domain/money';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, type WagerTransaction } from '../domain/wager-transaction';
import type { ProcessWagerInput, ProcessWagerResult } from '../application/process-wager-transaction.use-case';

export interface WagerHttpRequest {
  readonly headers: Readonly<Record<string, unknown>>;
  readonly rawHeaders?: readonly string[];
  readonly correlationId: string;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidDomainInputError('Expected string');
  requireText(value, 'value'); return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidDomainInputError('Expected object');
  if (Object.keys(value).some(key => !keys.includes(key))) throw new InvalidDomainInputError('Unknown field');
  return value as Record<string, unknown>;
}
export function idempotencyKey(request: Pick<WagerHttpRequest, 'headers' | 'rawHeaders'>): string {
  const value = text(request.headers['idempotency-key']);
  if (value !== value.trim()) throw new InvalidDomainInputError('Invalid Idempotency-Key whitespace');
  if (request.rawHeaders !== undefined) {
    const raw = request.rawHeaders;
    if (raw.length % 2 !== 0) throw new InvalidDomainInputError('Invalid headers');
    const occurrences: string[] = [];
    for (let index = 0; index < raw.length; index += 2) {
      if (raw[index]!.toLowerCase() === 'idempotency-key') occurrences.push(raw[index + 1]!);
    }
    if (occurrences.length !== 1 || occurrences[0] !== value) throw new InvalidDomainInputError('Expected exactly one Idempotency-Key');
  }
  return value;
}
export function wagerHttpInput(body: unknown, request: WagerHttpRequest): ProcessWagerInput {
  const key = idempotencyKey(request);
  const root = object(body, ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId']);
  const rawMoney = object(root['money'], ['amount', 'currency']);
  const money = Money.from({ amount: text(rawMoney['amount']), currency: text(rawMoney['currency']) });
  const providerId = text(root['providerId']);
  const externalTransactionId = text(root['externalTransactionId']);
  const kind = text(root['kind']) as Kind;
  if (!Object.values(Kind).includes(kind) || kind === Kind.Opening || providerId === 'SYSTEM') throw new InvalidDomainInputError('Invalid external wager');
  const rawReference = root['referenceExternalTransactionId'];
  const reference = rawReference === undefined || rawReference === null ? undefined : text(rawReference);
  if ((kind === Kind.Bet || kind === Kind.Loss) && reference !== undefined
    || (kind === Kind.Refund || kind === Kind.Rollback) && reference === undefined
    || reference === externalTransactionId
    || kind !== Kind.Loss && !money.isPositive()) throw new InvalidDomainInputError('Invalid wager input');
  return { providerId, externalTransactionId, playerId: text(root['playerId']), walletId: internalId(text(root['walletId'])),
    roundId: text(root['roundId']), gameId: text(root['gameId']), kind, money: money.toJSON(), idempotencyKey: key,
    correlationId: text(request.correlationId), ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }) };
}
export function wagerHttpStatus(result: ProcessWagerResult): number {
  switch (result.status) {
    case Status.Processed: return 200;
    case Status.PendingReference: return 202;
    case Status.Rejected: return 422;
    case Status.Failed:
      if (result.idempotentReplay) return 422;
      break;
  }
  throw new PersistenceInvariantError('Unexpected processing result status');
}

export function wagerQueryText(value: unknown): string {
  return text(value);
}
export function toWagerHttpResponse(transaction: WagerTransaction) {
  return { transactionId: transaction.id, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId, playerId: transaction.playerId, roundId: transaction.roundId, gameId: transaction.gameId,
    kind: transaction.kind, money: transaction.money.toJSON(), status: transaction.status, createdAt: transaction.createdAt.toISOString(),
    recordedBalance: transaction.recordedBalance?.toJSON() ?? null, referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null, failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt?.toISOString() ?? null };
}
