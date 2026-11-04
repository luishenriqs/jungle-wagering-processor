import { Money } from '../../../shared/domain/money';
import { InvalidLedgerEntryError } from '../../../shared/domain/domain-errors';
import { dateCopy, requireText } from '../../../shared/domain/validation';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }
export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}
export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
  readonly #state: LedgerEntryState;
  private constructor(state: LedgerEntryState) {
    this.#state = Object.freeze({ ...state, createdAt: dateCopy(state.createdAt) });
    Object.freeze(this);
  }
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    for (const field of ['id', 'walletId', 'transactionId'] as const) requireText(props[field], field);
    if (!Object.values(LedgerDirection).includes(props.direction) || !props.money.isPositive()
      || props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Invalid ledger amount, direction or balance');
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) throw new InvalidLedgerEntryError('Unbalanced ledger entry');
    return entry;
  }
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }
  get id(): string { return this.#state.id; }
  get walletId(): string { return this.#state.walletId; }
  get transactionId(): string { return this.#state.transactionId; }
  get direction(): LedgerDirection { return this.#state.direction; }
  get money(): Money { return this.#state.money; }
  get balanceBefore(): Money { return this.#state.balanceBefore; }
  get balanceAfter(): Money { return this.#state.balanceAfter; }
  get createdAt(): Date { return dateCopy(this.#state.createdAt); }
  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
