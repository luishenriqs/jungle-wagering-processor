import type { MoneyProps } from '../../../../shared/domain/money';
import { InvalidDomainInputError } from '../../../../shared/domain/domain-errors';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction';

export interface WagerEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly balance: MoneyProps;
}
export function wagerEventData(tx: WagerTransaction, status: WagerTransactionStatus): WagerEventData {
  if (tx.status !== status || !tx.recordedBalance) throw new InvalidDomainInputError(`Event requires ${status} with a balance snapshot`);
  return { transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind,
    money: tx.money.toJSON(), balance: tx.recordedBalance.toJSON() };
}
