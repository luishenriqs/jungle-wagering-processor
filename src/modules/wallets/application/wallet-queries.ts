import type { FinancialUnitOfWork, LedgerPosition } from '../../../shared/application/financial-store';
import { NotFoundError } from '../../../shared/application/application-errors';
import { internalId } from '../../../shared/application/identifiers';
import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { Money } from '../../../shared/domain/money';

export class GetWalletUseCase {
  constructor(private readonly uow: FinancialUnitOfWork) {}
  async execute(id: string) {
    return this.uow.run(async store => { const wallet = await store.getWallet(internalId(id)); if (!wallet) throw new NotFoundError('Wallet not found'); return wallet; });
  }
}
/** Decode opaque cursor without losing the PostgreSQL microsecond precision. */
export function parseLedgerCursor(value: unknown): LedgerPosition {
  try {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (Object.keys(cursor).length !== 2 || !Object.hasOwn(cursor, 'createdAt') || !Object.hasOwn(cursor, 'id')) throw new Error();
    const timestamp = cursor['createdAt'];
    if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(timestamp) || timestamp.startsWith('0000-')) throw new Error();
    // Date validates the calendar at milliseconds; return the original six-digit timestamp.
    const milliseconds = `${timestamp.slice(0, 23)}Z`;
    const calendar = new Date(milliseconds);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString() !== milliseconds || typeof cursor['id'] !== 'string') throw new Error();
    return { createdAt: timestamp, id: internalId(cursor['id']) };
  } catch { throw new InvalidDomainInputError('Invalid ledger cursor'); }
}
export class ListWalletLedgerUseCase {
  constructor(private readonly uow: FinancialUnitOfWork) {}
  async execute(input: { walletId: string; limit?: number; cursor?: string }) {
    const id = internalId(input.walletId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidDomainInputError('limit must be 1..100');
    const before = input.cursor === undefined ? undefined : parseLedgerCursor(input.cursor);
    return this.uow.run(async store => {
      if (!await store.getWallet(id)) throw new NotFoundError('Wallet not found');
      const rows = await store.ledgerPage(id, limit + 1, before);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { entries: page.map(row => row.entry), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify(last.position)).toString('base64url') : undefined };
    });
  }
}
export class ReconcileWalletUseCase {
  constructor(private readonly uow: FinancialUnitOfWork) {}
  async execute(id: string) {
    return this.uow.run(async store => {
      const wallet = await store.getWallet(internalId(id));
      if (!wallet) throw new NotFoundError('Wallet not found');
      const aggregate = await store.ledgerTotal(wallet.id);
      const calculated = Money.from({ amount: aggregate.amount, currency: wallet.currency });
      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero();
      if (!consistent) console.warn(JSON.stringify({ event: 'WalletReconciliationMismatch', walletId: wallet.id }));
      return { walletId: wallet.id, storedBalance: wallet.balance.toJSON(), calculatedBalance: calculated.toJSON(), difference: difference.toJSON(), consistent, checkedEntries: aggregate.count };
    }, 'repeatable read');
  }
}
