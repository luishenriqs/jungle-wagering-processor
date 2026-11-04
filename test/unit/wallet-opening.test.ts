import { expect, test } from 'bun:test';
import { createWalletOpening } from '../../src/modules/wagering/domain/wallet-opening';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { at, m } from '../fixtures';

const props = { walletId: 'wallet', playerId: 'player', initialBalance: m('1000.00'), transactionId: 'opening-tx', ledgerEntryId: 'opening-entry', payloadHash: 'a'.repeat(64), processedEventId: 'processed-event', balanceEventId: 'balance-event', context: { correlationId: 'correlation', occurredAt: at } };

test('positive opening bundles PROCESSED internal transaction, ledger and both events at version 1', () => {
  const result = createWalletOpening(props);
  expect(result.wallet.version).toBe(1);
  expect(result.transaction?.status).toBe(WagerTransactionStatus.Processed);
  expect(result.transaction?.kind).toBe(WagerTransactionKind.Opening);
  expect(result.transaction?.providerId).toBe('SYSTEM');
  expect(result.transaction?.externalTransactionId).toBe('opening:wallet');
  expect(result.transaction?.idempotencyKey).toBe('SYSTEM:opening:wallet');
  expect(result.transaction?.roundId).toBe('opening:wallet');
  expect(result.transaction?.gameId).toBe('SYSTEM_OPENING');
  expect(result.entry?.transactionId).toBe(result.transaction?.id);
  expect(result.entry?.balanceBefore.toString()).toBe('0.00');
  expect(result.entry?.balanceAfter.toString()).toBe('1000.00');
  expect(result.events.map(e => e.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  expect(result.events[1]?.data).toHaveProperty('walletVersion', 1);
});
test('zero opening creates no transaction, ledger or events', () => {
  const result = createWalletOpening({ ...props, initialBalance: m('0.00') });
  expect(result.wallet.version).toBe(1);
  expect(result.transaction).toBeUndefined();
  expect(result.entry).toBeUndefined();
  expect(result.events).toEqual([]);
});
test('positive opening rejects duplicate event identities', () => {
  expect(() => createWalletOpening({ ...props, balanceEventId: props.processedEventId })).toThrow();
});
test('three distinct wallets have distinct reserved provider IDs and keys', () => {
  const openings = ['a', 'b', 'c'].map(walletId => createWalletOpening({ ...props, walletId, transactionId: `tx-${walletId}`, ledgerEntryId: `entry-${walletId}`, processedEventId: `processed-${walletId}`, balanceEventId: `balance-${walletId}` }));
  expect(new Set(openings.map(o => o.transaction?.idempotencyKey)).size).toBe(3);
  expect(new Set(openings.map(o => o.transaction?.externalTransactionId)).size).toBe(3);
});
