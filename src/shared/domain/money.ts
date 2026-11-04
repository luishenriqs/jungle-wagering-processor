import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from './domain-errors';

export interface MoneyProps { readonly amount: string; readonly currency: string }

// Isolated configuration: sums of two NUMERIC(18,2) values need at most 19 digits.
const ExactDecimal = Decimal.clone({ precision: 40 });
const MAX = new ExactDecimal('9999999999999999.99');
const currencies = new Set(Intl.supportedValuesOf('currency'));

export class Money {
  readonly #value: Decimal;
  private constructor(value: Decimal, public readonly currency: string) {
    if (!value.isFinite() || value.abs().gt(MAX)) throw new MoneyOverflowError('NUMERIC(18,2) overflow');
    this.#value = value;
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== 'string' || !/^(0|[1-9]\d*)\.\d{2}$/.test(amount)) {
      throw new InvalidMoneyError('amount must be a nonnegative decimal string with exactly two places');
    }
    if (amount.length > 19) throw new MoneyOverflowError('NUMERIC(18,2) overflow');
    if (!currencies.has(currency)) throw new InvalidMoneyError('Unsupported ISO-4217 currency');
    return new Money(new ExactDecimal(amount), currency);
  }
  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.plus(other.#value), this.currency);
  }
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.minus(other.#value), this.currency);
  }
  negate(): Money { return new Money(this.#value.negated(), this.currency); }
  isZero(): boolean { return this.#value.isZero(); }
  isPositive(): boolean { return this.#value.gt('0'); }
  isNegative(): boolean { return this.#value.lt('0'); }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lt(other.#value);
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.eq(other.#value);
  }
  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
  toString(): string { return this.#value.toFixed(2); }
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError('Currencies must match');
  }
}
