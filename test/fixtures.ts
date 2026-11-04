import { Money } from '../src/shared/domain/money';
import { WagerTransaction, WagerTransactionKind, type CreateWagerTransactionProps } from '../src/modules/wagering/domain/wager-transaction';

export const at = new Date('2026-11-04T12:00:00.000Z');
export const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
export function createTransactionProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return { id: 'tx', providerId: 'provider', externalTransactionId: 'external-tx', idempotencyKey: 'provider:external-tx', payloadHash: 'a'.repeat(64), walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Bet, money: m('10.00'), createdAt: new Date(at), ...overrides };
}
export function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const tx = WagerTransaction.create(createTransactionProps(overrides));
  tx.markProcessed(tx.requiresReference() ? 'original' : undefined, at, m('100.00'));
  return tx;
}
