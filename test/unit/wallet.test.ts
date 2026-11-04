import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const at = new Date('2026-11-04T12:00:00.000Z');
const open = (amount = '100.00') => Wallet.open({ id: 'w', playerId: 'p', initialBalance: m(amount), at, opening: { transactionId: 'opening-w', ledgerEntryId: 'opening-entry' } });
const movement = { transactionId: 'tx', ledgerEntryId: 'entry', money: m('20.00'), at };

test('positive and zero openings preserve version 1', () => {
  const wallet = open();
  expect(wallet.version).toBe(1);
  expect(wallet.openingEntry?.balanceBefore.toString()).toBe('0.00');
  expect(wallet.openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
  const zero = open('0.00');
  expect(zero.openingEntry).toBeUndefined();
  expect(zero.version).toBe(1);
  expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: m('1.00'), at })).toThrow();
  expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: m('1.00').negate(), at })).toThrow();
});
test('movements return a corresponding ledger entry and increment version once', () => {
  const wallet = open();
  const debit = wallet.debit(movement);
  expect(debit.balanceBefore.toString()).toBe('100.00');
  expect(debit.balanceAfter.toString()).toBe('80.00');
  expect(wallet.version).toBe(2);
  expect(wallet.balance.equals(debit.balanceAfter)).toBe(true);
  const credit = wallet.credit({ ...movement, transactionId: 'tx2', ledgerEntryId: 'entry2' });
  expect(wallet.balance.toString()).toBe('100.00');
  expect(wallet.version).toBe(3);
  expect(credit.isBalanced()).toBe(true);
});
test('exact balance debit reaches zero', () => {
  const wallet = open('20.00');
  wallet.debit(movement);
  expect(wallet.balance.isZero()).toBe(true);
});
test('rejections do not partially change balance, version or updatedAt', () => {
  const wallet = open('10.00');
  for (const change of [
    {}, { money: m('0.00') }, { money: m('1.00').negate() },
    { money: m('1.00', 'USD') }, { at: new Date('invalid') }, { ledgerEntryId: '' },
  ]) {
    expect(() => wallet.debit({ ...movement, ...change })).toThrow();
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString()).toBe(at.toISOString());
  }
  const max = open('9999999999999999.99');
  expect(() => max.credit(movement)).toThrow();
  expect(max.version).toBe(1);
});
test('insufficient bet and reversal have different stable failure codes', () => {
  const wallet = open('0.00');
  for (const code of [FailureCode.InsufficientFundsBet, FailureCode.InsufficientFundsReversal] as const) {
    try { wallet.debit({ ...movement, insufficientFundsCode: code }); throw new Error('should fail'); }
    catch (error) { expect(error).toHaveProperty('code', code); }
  }
});
test('rehydration and dates do not replay opening or transitions', () => {
  const date = new Date(at);
  const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: m('7.00'), version: 9, createdAt: date, updatedAt: date });
  date.setFullYear(2000);
  wallet.updatedAt.setFullYear(2001);
  expect(wallet.version).toBe(9);
  expect(wallet.balance.toString()).toBe('7.00');
  expect(wallet.openingEntry).toBeUndefined();
  expect(wallet.createdAt.toISOString()).toBe(at.toISOString());
  expect(wallet.updatedAt.toISOString()).toBe(at.toISOString());
  expect(Reflect.set(wallet, 'balance', m('0.00'))).toBe(false);
});
