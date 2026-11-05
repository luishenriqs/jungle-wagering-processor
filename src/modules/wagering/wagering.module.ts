import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWork } from '../../shared/application/financial-store';
import { CLOCK, SystemClock, type ClockPort } from '../../shared/application/clock';
import { pendingReferencePolicy, type PendingReferencePolicy } from './application/pending-reference-policy';
import { PendingReferenceWorker } from './application/pending-reference-worker';
import { PendingReferenceLifecycle } from './infrastructure/pending-reference-lifecycle';

@Module({})
export class WageringModule {
  static forPendingReferences(): DynamicModule {
    const POLICY = Symbol('PENDING_REFERENCE_POLICY'); const LOOP = Symbol('PENDING_REFERENCE_LOOP');
    return { module: WageringModule, imports: [DatabaseModule.forRoot()], providers: [
      { provide: CLOCK, useFactory: () => new SystemClock() },
      { provide: POLICY, useFactory: () => pendingReferencePolicy() },
      { provide: LOOP, useFactory: () => {
        const integer = (key: string, fallback: number, max: number) => {
          const raw = process.env[key] ?? String(fallback);
          if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) throw new Error(`Invalid ${key}`);
          return Number(raw);
        };
        return { pollMs: integer('PENDING_REF_POLL_INTERVAL_MS', 250, 60000), batchSize: integer('PENDING_REF_BATCH_SIZE', 100, 1000) };
      } },
      { provide: PendingReferenceWorker, inject: [FINANCIAL_UNIT_OF_WORK, CLOCK, POLICY],
        useFactory: (uow: FinancialUnitOfWork, clock: ClockPort, policy: PendingReferencePolicy) => new PendingReferenceWorker(uow, clock, policy) },
      { provide: PendingReferenceLifecycle, inject: [PendingReferenceWorker, LOOP],
        useFactory: (worker: PendingReferenceWorker, loop: { pollMs: number; batchSize: number }) => new PendingReferenceLifecycle(worker, loop.pollMs, loop.batchSize) },
    ], exports: [PendingReferenceWorker] };
  }
}
