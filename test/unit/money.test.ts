import { expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Money } from '../../src/shared/domain/money';

const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

test('exact decimal arithmetic without changing operands', () => {
  const a = money('0.10');
  expect(a.add(money('0.20')).toString()).toBe('0.30');
  expect(a.toString()).toBe('0.10');
  expect(a.subtract(money('0.20')).toString()).toBe('-0.10');
  expect(a.negate().negate().equals(a)).toBe(true);
  expect(a.add(Money.zero('BRL'))).not.toBe(a);
});
test.each(['', 'NaN', 'Infinity', '-Infinity', '1e2', '1E2', '1.001', '-0.01', '-0.00', '1', '1.0', '.10', '+1.00', ' 1.00', '1.00 ', '01.00', '1,00', '0x10', '10000000000000000.00'])('invalid external amount %s', (amount) => {
  expect(() => money(amount)).toThrow();
});
test('numbers are not accepted as monetary inputs at runtime', () => {
  // @ts-expect-error Deliberately exercise untyped contract input.
  expect(() => Money.from({ amount: 1.25, currency: 'BRL' })).toThrow();
});
test('NUMERIC limits and no silent rounding', () => {
  const max = money('9999999999999999.99');
  expect(max.subtract(money('0.01')).toString()).toBe('9999999999999999.98');
  expect(() => max.add(money('0.01'))).toThrow();
  expect(() => max.negate().subtract(money('0.01'))).toThrow();
});
test('currency mismatch on every binary operation', () => {
  const a = money('1.00');
  const b = money('1.00', 'USD');
  for (const op of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
    expect(() => a[op](b)).toThrow();
  }
  for (const currency of ['brl', '', 'ZZZ', 'BR']) expect(() => money('1.00', currency)).toThrow();
});
test('queries, serialization and runtime immutability', () => {
  const a = money('1.00');
  expect(a.isPositive()).toBe(true);
  expect(a.isNegative()).toBe(false);
  expect(a.negate().isNegative()).toBe(true);
  expect(Money.zero('BRL').isPositive()).toBe(false);
  expect(Money.zero('BRL').isZero()).toBe(true);
  expect(a.isLessThan(money('2.00'))).toBe(true);
  expect(a.equals(money('2.00'))).toBe(false);
  expect(JSON.parse(JSON.stringify(a))).toEqual({ amount: '1.00', currency: 'BRL' });
  expect(Reflect.set(a, 'currency', 'USD')).toBe(false);
  const json = a.toJSON();
  Reflect.set(json, 'amount', '9.00');
  expect(a.toString()).toBe('1.00');
});
test('global decimal configuration cannot change Money precision', () => {
  const original = Decimal.precision;
  try {
    Decimal.set({ precision: 2 });
    expect(money('9999999999999999.98').add(money('0.01')).toString()).toBe('9999999999999999.99');
  } finally { Decimal.set({ precision: original }); }
});
