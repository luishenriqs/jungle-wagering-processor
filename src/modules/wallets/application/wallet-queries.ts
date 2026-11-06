import type { FinancialUnitOfWork, LedgerPosition } from '../../../shared/application/financial-store';
import { NotFoundError, PersistenceInvariantError } from '../../../shared/application/application-errors';
import { internalId } from '../../../shared/application/identifiers';
import { CurrencyMismatchError, InvalidDomainInputError, InvalidMoneyError, MoneyOverflowError } from '../../../shared/domain/domain-errors';
import { Money } from '../../../shared/domain/money';
import { isolatedObserver, operationalEmitter, type OperationalLoggingOptions } from '../../../shared/application/operational-logging';
import { operationalMetricsEmitter, type OperationalMetricsOptions } from '../../../shared/application/operational-metrics';

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
/** Operational observations are per instance/process, not distinct financial incidents. */
export class ReconcileWalletUseCase {
  #divergenceObservations = 0n;
  private readonly observe;
  private readonly legacyLog;
  private readonly emitMetric;
  constructor(private readonly uow: FinancialUnitOfWork, private readonly telemetry: {
    log?: (event: { event: 'WalletReconciliationMismatch'; walletId: string; correlationId?: string }) => void;
    metric?: (total: bigint) => void;
  } & OperationalLoggingOptions & OperationalMetricsOptions = {}) {
    this.observe = operationalEmitter(telemetry.operationalLog); this.legacyLog = isolatedObserver(telemetry.log);
    this.emitMetric = operationalMetricsEmitter(telemetry.operationalMetrics);
  }
  /** Monotonic total available to a future metrics collector without wallet labels. */
  get divergenceObservations(): bigint { return this.#divergenceObservations; }
  async execute(id: string, context?: { correlationId: string }) {
    const walletId = internalId(id);
    const result = await this.uow.run(async store => {
      const wallet = await store.getWallet(walletId);
      if (!wallet) throw new NotFoundError('Wallet not found');
      const aggregate = await store.ledgerTotal(wallet.id);
      let calculated: Money;
      let difference: Money;
      try {
        const amount = aggregate.amount;
        if (typeof amount !== 'string' || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(amount) || amount === '-0.00') {
          throw new InvalidMoneyError('Invalid internal aggregate');
        }
        const negative = amount.startsWith('-');
        const magnitude = Money.from({ amount: negative ? amount.slice(1) : amount, currency: wallet.currency });
        calculated = negative ? magnitude.negate() : magnitude;
        difference = wallet.balance.subtract(calculated);
      } catch (error) {
        if (error instanceof InvalidMoneyError || error instanceof MoneyOverflowError || error instanceof CurrencyMismatchError) {
          throw new PersistenceInvariantError('Invalid reconciliation money', { cause: error });
        }
        throw error;
      }
      return { walletId: wallet.id, storedBalance: wallet.balance.toJSON(), calculatedBalance: calculated.toJSON(), difference: difference.toJSON(), consistent: difference.isZero(), checkedEntries: aggregate.count };
    }, 'repeatable read');
    // Observe only after the UoW completes; telemetry never retries or replaces a diagnosis.
    if (!result.consistent) {
      const total = ++this.#divergenceObservations;
      try { this.telemetry.metric?.(total); } catch { /* Collection failure cannot invalidate financial reads. */ }
      try {
        const event = { event: 'WalletReconciliationMismatch' as const, walletId: result.walletId,
          ...(context ? { correlationId: context.correlationId } : {}) };
        if (this.telemetry.log) this.legacyLog(event);
        else if (this.telemetry.operationalLog) this.observe({ component: 'wallets', event: 'reconciliation_divergence', level: 'warn',
          walletId: result.walletId, correlationId: context?.correlationId });
        else console.warn(JSON.stringify(event));
      } catch { /* Logging failure cannot invalidate financial reads. */ }
      this.emitMetric({ type: 'reconciliation-divergence' });
    }
    return result;
  }
}
