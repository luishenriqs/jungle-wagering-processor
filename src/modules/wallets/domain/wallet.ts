import { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError, InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { dateCopy, requireText } from '../../../shared/domain/validation';
import { FailureCode } from '../../wagering/domain/failure-code';
import { WagerRuleError } from '../../wagering/domain/wager-errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  readonly opening?: { readonly transactionId: string; readonly ledgerEntryId: string };
}
export interface WalletMovement {
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly money: Money;
  readonly at: Date;
}
export type InsufficientFundsCode = FailureCode.InsufficientFundsBet | FailureCode.InsufficientFundsReversal;

export class Wallet {
  readonly #identity: Pick<WalletState, 'id' | 'playerId' | 'currency' | 'createdAt'>;
  #balance: Money;
  #version: number;
  #updatedAt: Date;
  readonly #openingEntry: WalletLedgerEntry | undefined;
  private constructor(state: WalletState, openingEntry?: WalletLedgerEntry) {
    this.#identity = Object.freeze({ id: state.id, playerId: state.playerId, currency: state.currency, createdAt: dateCopy(state.createdAt) });
    this.#balance = state.balance;
    this.#version = state.version;
    this.#updatedAt = dateCopy(state.updatedAt);
    this.#openingEntry = openingEntry;
    Object.freeze(this);
  }
  static open(props: OpenWalletProps): Wallet {
    requireText(props.id, 'walletId');
    requireText(props.playerId, 'playerId');
    if (props.initialBalance.isNegative()) throw new InvalidDomainInputError('Initial balance cannot be negative');
    let entry: WalletLedgerEntry | undefined;
    if (props.initialBalance.isPositive()) {
      if (!props.opening) throw new InvalidDomainInputError('Positive opening requires ledger and transaction identities');
      entry = WalletLedgerEntry.create({ id: props.opening.ledgerEntryId, transactionId: props.opening.transactionId,
        walletId: props.id, direction: LedgerDirection.Credit, money: props.initialBalance,
        balanceBefore: Money.zero(props.initialBalance.currency), balanceAfter: props.initialBalance, createdAt: props.at });
    }
    return new Wallet({ id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: props.at, updatedAt: props.at }, entry);
  }
  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }
  get id(): string { return this.#identity.id; }
  get playerId(): string { return this.#identity.playerId; }
  get currency(): string { return this.#identity.currency; }
  get balance(): Money { return this.#balance; }
  get version(): number { return this.#version; }
  get createdAt(): Date { return dateCopy(this.#identity.createdAt); }
  get updatedAt(): Date { return dateCopy(this.#updatedAt); }
  get openingEntry(): WalletLedgerEntry | undefined { return this.#openingEntry; }
  debit(props: WalletMovement & { readonly insufficientFundsCode?: InsufficientFundsCode }): WalletLedgerEntry {
    return this.move(props, LedgerDirection.Debit, props.insufficientFundsCode ?? FailureCode.InsufficientFundsBet);
  }
  credit(props: WalletMovement): WalletLedgerEntry { return this.move(props, LedgerDirection.Credit); }
  private move(props: WalletMovement, direction: LedgerDirection, insufficientCode = FailureCode.InsufficientFundsBet): WalletLedgerEntry {
    if (this.currency !== props.money.currency) throw new CurrencyMismatchError('Wallet currency mismatch');
    if (!props.money.isPositive()) throw new InvalidDomainInputError('Movement must be positive');
    if (!Number.isSafeInteger(this.#version + 1)) throw new InvalidDomainInputError('Wallet version overflow');
    const at = dateCopy(props.at);
    const after = direction === LedgerDirection.Credit ? this.#balance.add(props.money) : this.#balance.subtract(props.money);
    if (after.isNegative()) throw new WagerRuleError(insufficientCode);
    const entry = WalletLedgerEntry.create({ id: props.ledgerEntryId, walletId: this.id, transactionId: props.transactionId,
      direction, money: props.money, balanceBefore: this.#balance, balanceAfter: after, createdAt: at });
    this.#balance = after;
    this.#version += 1;
    this.#updatedAt = at;
    return entry;
  }
}
