import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import type { WagerTransactionKind } from '../domain/wager-transaction';

export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}
function sortedJson(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function canonicalWagerPayload(input: WagerPayload): string {
  return sortedJson({ providerId: input.providerId, externalTransactionId: input.externalTransactionId,
    playerId: input.playerId, walletId: input.walletId, roundId: input.roundId, gameId: input.gameId,
    kind: input.kind, money: Money.from(input.money).toJSON(), referenceExternalTransactionId: input.referenceExternalTransactionId ?? null });
}
export function wagerPayloadHash(input: WagerPayload): string {
  return createHash('sha256').update(canonicalWagerPayload(input), 'utf8').digest('hex');
}
