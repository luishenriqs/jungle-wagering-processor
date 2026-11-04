import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const at = new Date('2026-11-04T12:00:00.000Z');
const props = { id: 'entry', walletId: 'wallet', transactionId: 'tx', direction: LedgerDirection.Credit, money: m('2.00'), balanceBefore: m('1.00'), balanceAfter: m('3.00'), createdAt: at };

test('credit, debit and rehydration are balanced', () => {
  expect(WalletLedgerEntry.create(props).isBalanced()).toBe(true);
  const debit = { ...props, direction: LedgerDirection.Debit, balanceBefore: m('3.00'), balanceAfter: m('1.00') };
  expect(WalletLedgerEntry.create(debit).isBalanced()).toBe(true);
  expect(WalletLedgerEntry.rehydrate(debit).isBalanced()).toBe(true);
});
test('reject invalid amounts, arithmetic, balances, currencies and direction', () => {
  for (const change of [
    { money: m('0.00') }, { money: m('1.00').negate() },
    { balanceAfter: m('4.00') }, { balanceBefore: m('1.00').negate() },
    { balanceAfter: m('1.00').negate() }, { money: m('2.00', 'USD') },
    { direction: 'INVALID' as LedgerDirection },
  ]) expect(() => WalletLedgerEntry.create({ ...props, ...change })).toThrow();
});
test('ledger fields and dates cannot be mutated through inputs or getters', () => {
  const date = new Date(at);
  const input = { ...props, createdAt: date };
  const entry = WalletLedgerEntry.create(input);
  date.setFullYear(2000);
  input.id = 'other';
  entry.createdAt.setFullYear(2001);
  expect(entry.createdAt.toISOString()).toBe(at.toISOString());
  expect(entry.id).toBe('entry');
  expect(Reflect.set(entry, 'money', m('9.00'))).toBe(false);
});
