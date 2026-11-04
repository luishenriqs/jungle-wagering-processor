import { expect, test } from 'bun:test';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind as K } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionRejected } from '../../src/modules/wagering/domain/events/wager-transaction-rejected';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { walletDomain, walletRecord, wagerDomain, wagerRecord, ledgerDomain, ledgerRecord, inboxDomain, outboxDomain, outboxRecord } from '../../src/database/mappers';
import { at, m, createTransactionProps } from '../fixtures';

test('wallet and ledger mapping preserves decimal strings, versions and external player ID', () => {
  const wallet = Wallet.open({ id: 'wallet', playerId: 'player-test-01', initialBalance: m('9999999999999999.99'), at, opening: { transactionId: 'opening', ledgerEntryId: 'entry' } });
  const rehydrated = walletDomain(walletRecord(wallet));
  expect(rehydrated.balance.toString()).toBe('9999999999999999.99');
  expect(rehydrated.playerId).toBe('player-test-01');
  expect(rehydrated.version).toBe(1);
  expect(rehydrated.openingEntry).toBeUndefined();
  const entry = wallet.openingEntry!;
  expect(ledgerDomain(ledgerRecord(entry)).isBalanced()).toBe(true);
});
test('currency rejection preserves original operation money and wallet snapshot currency', () => {
  const tx = WagerTransaction.create(createTransactionProps({ money: m('10.00', 'USD') }));
  tx.reject(FailureCode.CurrencyMismatch, m('100.00'));
  const restored = wagerDomain(wagerRecord(tx));
  expect(restored.money.currency).toBe('USD');
  expect(restored.recordedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  expect(restored.failureCode).toBe(FailureCode.CurrencyMismatch);
  const event = WagerTransactionRejected.from(restored, { eventId: 'event', correlationId: 'correlation', occurredAt: at });
  const outbox = outboxDomain(outboxRecord(OutboxMessage.enqueue(event)));
  expect(outbox.payload).toEqual({ ...event.toJSON() });
  expect(outbox.attempts).toBe(0);
});
test('pending state, retry schedule and processed inbox roundtrip without transitions', () => {
  const tx = WagerTransaction.create(createTransactionProps({ kind: K.Refund, referenceExternalTransactionId: 'bet' }));
  tx.markPendingReference(m('100.00'), { nextRetryAt: at, expiresAt: new Date(at.getTime() + 10000) });
  tx.reschedulePendingReference(new Date(at.getTime() + 1000));
  const restored = wagerDomain(wagerRecord(tx));
  expect(restored.attempts).toBe(1);
  expect(restored.nextRetryAt?.getTime()).toBe(at.getTime() + 1000);
  const inbox = InboxMessage.receive({ consumerName: 'consumer', messageId: 'message', payloadHash: 'a'.repeat(64), receivedAt: at });
  inbox.markProcessed(at);
  expect(inboxDomain({ consumer_name: inbox.consumerName, message_id: inbox.messageId, payload_hash: inbox.payloadHash, received_at: inbox.receivedAt, processed_at: inbox.processedAt! }).isProcessed()).toBe(true);
});
