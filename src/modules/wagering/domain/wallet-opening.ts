import type { EventContext, IntegrationEvent } from '../../../shared/domain/events/integration-event';
import type { Money } from '../../../shared/domain/money';
import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed';
import { WagerTransaction } from './wager-transaction';
import { WagerTransactionProcessed } from './events/wager-transaction-processed';

export interface WalletOpeningProps {
  readonly walletId: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly payloadHash: string;
  readonly processedEventId: string;
  readonly balanceEventId: string;
  readonly context: Omit<EventContext, 'eventId'>;
}
export interface WalletOpening {
  readonly wallet: Wallet;
  readonly transaction?: WagerTransaction;
  readonly entry?: WalletLedgerEntry;
  readonly events: readonly IntegrationEvent<unknown>[];
}
/** Pure opening bundle. A future use case must persist every artifact atomically. */
export function createWalletOpening(props: WalletOpeningProps): WalletOpening {
  const wallet = Wallet.open({ id: props.walletId, playerId: props.playerId, initialBalance: props.initialBalance,
    at: props.context.occurredAt, opening: { transactionId: props.transactionId, ledgerEntryId: props.ledgerEntryId } });
  const entry = wallet.openingEntry;
  if (!entry) return Object.freeze({ wallet, events: Object.freeze([]) });
  if (props.processedEventId === props.balanceEventId) throw new InvalidDomainInputError('Opening events require distinct identities');
  const transaction = WagerTransaction.createOpening({ id: props.transactionId, walletId: wallet.id, playerId: wallet.playerId,
    money: props.initialBalance, payloadHash: props.payloadHash, createdAt: props.context.occurredAt });
  const events = Object.freeze([
    WagerTransactionProcessed.from(transaction, { ...props.context, eventId: props.processedEventId }),
    WalletBalanceChanged.from(wallet, entry, { ...props.context, eventId: props.balanceEventId }),
  ]);
  return Object.freeze({ wallet, transaction, entry, events });
}
