import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { requireText } from '../../../shared/domain/validation';
import { internalId } from '../../../shared/application/identifiers';
import type { ClockPort } from '../../../shared/application/clock';
import { Money } from '../../../shared/domain/money';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction';
import type { ProcessWagerInput } from '../../wagering/application/process-wager-transaction.use-case';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidDomainInputError('Expected object');
  return value as Record<string, unknown>;
}
function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new InvalidDomainInputError(`Invalid ${key}`);
  requireText(value, key); return value;
}
function occurredAt(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
    throw new InvalidDomainInputError('Expected ISO-8601 occurredAt');
  }
  const calendar = new Date(`${value.slice(0, 19)}Z`);
  if (!Number.isFinite(Date.parse(value)) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new InvalidDomainInputError('Invalid occurredAt');
  }
}
/** Whitelist business fields; transport metadata never reaches canonical hashing. */
export function wagerRequest(body: string, consumerName: string, clock: ClockPort): ProcessWagerInput {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new InvalidDomainInputError('Invalid JSON'); }
  const envelope = object(raw);
  if (envelope['type'] !== 'WagerTransactionRequested') throw new InvalidDomainInputError('Invalid message type');
  const messageId = text(envelope, 'messageId');
  occurredAt(text(envelope, 'occurredAt'));
  const data = object(envelope['data']); const money = object(data['money']);
  const kind = text(data, 'kind');
  if (!Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind) || kind === WagerTransactionKind.Opening) {
    throw new InvalidDomainInputError('Invalid external wager kind');
  }
  const reference = data['referenceExternalTransactionId'];
  return { providerId: text(data, 'providerId'), externalTransactionId: text(data, 'externalTransactionId'),
    idempotencyKey: text(data, 'idempotencyKey'), playerId: text(data, 'playerId'), walletId: internalId(text(data, 'walletId')),
    roundId: text(data, 'roundId'), gameId: text(data, 'gameId'), kind: kind as WagerTransactionKind,
    money: Money.from({ amount: text(money, 'amount'), currency: text(money, 'currency') }).toJSON(),
    ...(reference === undefined || reference === null ? {} : { referenceExternalTransactionId: text(data, 'referenceExternalTransactionId') }),
    correlationId: envelope['correlationId'] === undefined ? messageId : text(envelope, 'correlationId'),
    causationId: messageId,
    inbox: { consumerName, messageId, receivedAt: clock.now() } };
}
