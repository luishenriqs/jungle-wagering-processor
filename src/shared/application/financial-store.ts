import type { Wallet } from '../../modules/wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../modules/wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../../modules/wagering/domain/wager-transaction';
import type { InboxMessage } from '../../modules/messaging/domain/inbox-message';
import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';

export interface LedgerPosition { readonly createdAt: string; readonly id: string }
export interface LedgerPageItem { readonly entry: WalletLedgerEntry; readonly position: LedgerPosition }
export interface FinancialStore {
  getWallet(id: string, lock?: boolean): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  updateWallet(wallet: Wallet): Promise<void>;
  getWager(id: string, lock?: boolean): Promise<WagerTransaction | undefined>;
  findWager(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  findIdentity(key: string, providerId: string, externalId: string): Promise<WagerTransaction[]>;
  insertWager(tx: WagerTransaction): Promise<void>;
  isReversed(referenceId: string): Promise<boolean>;
  appendLedger(entry: WalletLedgerEntry): Promise<void>;
  enqueue(message: OutboxMessage): Promise<void>;
  claimInbox(message: InboxMessage): Promise<{ readonly inserted: boolean; readonly message: InboxMessage }>;
  finishInbox(message: InboxMessage): Promise<void>;
  ledgerPage(walletId: string, limit: number, before?: LedgerPosition): Promise<LedgerPageItem[]>;
  ledgerTotal(walletId: string): Promise<{ readonly amount: string; readonly count: number }>;
}
export interface FinancialUnitOfWork {
  run<T>(work: (store: FinancialStore) => Promise<T>, isolation?: 'read committed' | 'repeatable read'): Promise<T>;
}
export const FINANCIAL_UNIT_OF_WORK = Symbol('FINANCIAL_UNIT_OF_WORK');
