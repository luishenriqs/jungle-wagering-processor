import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { Money } from '../../../shared/domain/money';
import { requireText } from '../../../shared/domain/validation';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { parseLedgerCursor } from '../application/wallet-queries';

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidDomainInputError('Expected object');
  if (Object.keys(value).some(key => !keys.includes(key))) throw new InvalidDomainInputError('Unknown field');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidDomainInputError('Expected string');
  requireText(value, 'value');
  return value;
}
export function createWalletHttpInput(body: unknown) {
  const root = object(body, ['playerId', 'initialBalance']);
  const balance = object(root['initialBalance'], ['amount', 'currency']);
  return { playerId: text(root['playerId']), initialBalance: Money.from({ amount: text(balance['amount']), currency: text(balance['currency']) }).toJSON() };
}
export function toWalletHttpResponse(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

export function ledgerHttpQuery(query: unknown): { limit?: number; cursor?: string } {
  const values = object(query, ['limit', 'cursor']);
  const rawLimit = values['limit'];
  const cursor = values['cursor'];
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^[1-9][0-9]*$/.test(rawLimit)) throw new InvalidDomainInputError('Invalid ledger limit');
    limit = Number(rawLimit); // Pagination count only; money is never converted.
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidDomainInputError('Invalid ledger limit');
  }
  if (cursor !== undefined) parseLedgerCursor(cursor);
  return { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor: cursor as string }) };
}
export function toLedgerHttpResponse(page: { entries: WalletLedgerEntry[]; nextCursor?: string | undefined }) {
  return { entries: page.entries.map(entry => ({ id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
    direction: entry.direction, money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(), createdAt: entry.createdAt.toISOString() })), nextCursor: page.nextCursor ?? null };
}

/** Reconciliation accepts no financial input or query parameters. */
export function reconciliationHttpInput(body: unknown, query: unknown): void {
  if (body !== undefined) object(body, []);
  object(query, []);
}
