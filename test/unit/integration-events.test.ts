import { expect, test } from 'bun:test';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WalletBalanceChanged } from '../../src/modules/wallets/domain/events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../../src/modules/wagering/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../src/modules/wagering/domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../../src/modules/wagering/domain/events/wager-transaction-pending-reference';
import { WagerTransaction, WagerTransactionKind as K } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { at, createTransactionProps, m, processed } from '../fixtures';

const ctx = { eventId: 'event', correlationId: 'correlation', causationId: 'cause', occurredAt: at };

test('four concrete envelopes have fixed type/version and JSON decimal money', () => {
  const tx = processed();
  const rejected = WagerTransaction.create(createTransactionProps());
  rejected.reject(FailureCode.InsufficientFundsBet, m('0.00'));
  const pending = WagerTransaction.create(createTransactionProps({ kind: K.Refund, referenceExternalTransactionId: 'bet' }));
  pending.markPendingReference(m('100.00'), { nextRetryAt: at, expiresAt: new Date(at.getTime() + 1000) });
  const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: m('0.00'), at });
  const entry = wallet.credit({ transactionId: tx.id, ledgerEntryId: 'entry', money: m('10.00'), at });
  const events = [WagerTransactionProcessed.from(tx, ctx), WagerTransactionRejected.from(rejected, ctx),
    WagerTransactionPendingReference.from(pending, ctx), WalletBalanceChanged.from(wallet, entry, ctx)];
  expect(events.map(e => e.eventType)).toEqual(['WagerTransactionProcessed', 'WagerTransactionRejected', 'WagerTransactionPendingReference', 'WalletBalanceChanged']);
  for (const event of events) {
    const envelope = event.toJSON();
    expect(envelope).toMatchObject({ eventId: 'event', correlationId: 'correlation', causationId: 'cause', aggregateId: 'wallet', occurredAt: at.toISOString(), version: 1 });
    expect(envelope.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(JSON.parse(JSON.stringify(event))).toEqual(envelope);
    expect(Reflect.set(event, 'eventType', 'changed')).toBe(false);
    expect(Reflect.set(event.data.money, 'amount', '99.00')).toBe(false);
  }
});
test('LOSS has Processed event and no balance movement', () => {
  const tx = processed({ kind: K.Loss, money: m('0.00') });
  expect(WagerTransactionProcessed.from(tx, ctx).data.kind).toBe(K.Loss);
  expect(tx.affectsBalance()).toBe(false);
});
test('events reject incompatible transaction states and mismatched wallets', () => {
  const tx = WagerTransaction.create(createTransactionProps());
  expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow();
  expect(() => WagerTransactionRejected.from(tx, ctx)).toThrow();
  expect(() => WagerTransactionPendingReference.from(tx, ctx)).toThrow();
  const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: m('0.00'), at });
  const other = Wallet.open({ id: 'other', playerId: 'player', initialBalance: m('0.00'), at });
  const entry = wallet.credit({ transactionId: 'tx', ledgerEntryId: 'entry', money: m('10.00'), at });
  expect(() => WalletBalanceChanged.from(other, entry, ctx)).toThrow();
  wallet.credit({ transactionId: 'tx2', ledgerEntryId: 'entry2', money: m('10.00'), at });
  expect(() => WalletBalanceChanged.from(wallet, entry, ctx)).toThrow();
  expect(() => WagerTransactionProcessed.from(processed(), { ...ctx, eventId: '' })).toThrow();
});
