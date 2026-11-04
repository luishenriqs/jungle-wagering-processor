import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../../../../shared/domain/events/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import { InvalidDomainInputError } from '../../../../shared/domain/domain-errors';
import type { Wallet } from '../wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); Object.freeze(this); }
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (wallet.id !== entry.walletId || !entry.money.isPositive() || !entry.isBalanced()
      || !wallet.balance.equals(entry.balanceAfter)) throw new InvalidDomainInputError('Balance event requires a matching wallet movement');
    return new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id,
      data: { walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction, money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version } });
  }
}
