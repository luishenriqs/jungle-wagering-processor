import { PostgresHealthProbe, POSTGRES_HEALTH_PROBE } from '../shared/infrastructure/postgres-health.probe';
import { Module, type DynamicModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { ServiceUnavailableException } from '@nestjs/common';
import { databaseConfig } from './config';
import { PostgresUnitOfWork } from './postgres-unit-of-work';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWork } from '../shared/application/financial-store';
import { CreateWalletUseCase } from '../modules/wallets/application/create-wallet.use-case';
import { GetWalletUseCase, ListWalletLedgerUseCase, ReconcileWalletUseCase } from '../modules/wallets/application/wallet-queries';
import { ProcessWagerTransactionUseCase } from '../modules/wagering/application/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../modules/wagering/application/get-wager-transaction.use-case';
import { stderrOperationalLog } from '../shared/infrastructure/structured-logger';
import { DefaultOperationalMetricsCollector, OPERATIONAL_METRICS, type OperationalMetricsCollector } from '../shared/application/operational-metrics';

interface DatabaseMetricsOptions { readonly metrics?: OperationalMetricsCollector | undefined }

function metricsProvider(metrics?: OperationalMetricsCollector) {
  return { provide: OPERATIONAL_METRICS, useFactory: (): OperationalMetricsCollector => metrics ?? new DefaultOperationalMetricsCollector() };
}

const cases = [CreateWalletUseCase, GetWalletUseCase, ListWalletLedgerUseCase, ReconcileWalletUseCase, ProcessWagerTransactionUseCase, GetWagerTransactionUseCase];
function caseProviders() {
  return cases.map(useCase => ({ provide: useCase,
    inject: useCase === CreateWalletUseCase || useCase === ProcessWagerTransactionUseCase || useCase === ReconcileWalletUseCase
      ? [FINANCIAL_UNIT_OF_WORK, OPERATIONAL_METRICS] : [FINANCIAL_UNIT_OF_WORK],
    useFactory: (work: FinancialUnitOfWork, metrics?: OperationalMetricsCollector) => {
    const options = { operationalLog: stderrOperationalLog, operationalMetrics: metrics };
    if (useCase === CreateWalletUseCase) return new CreateWalletUseCase(work, options);
    if (useCase === ProcessWagerTransactionUseCase) return new ProcessWagerTransactionUseCase(work, options);
    if (useCase === ReconcileWalletUseCase) return new ReconcileWalletUseCase(work, { operationalMetrics: metrics });
    return new useCase(work);
  } }));
}
@Module({})
export class DatabaseModule {
  /** HTTP owns exactly one ORM; an injected UoW retains ownership with its caller. */
  static forHttp(uow?: FinancialUnitOfWork, options: DatabaseMetricsOptions = {}): DynamicModule {
    const resource = Symbol('HTTP_DATABASE_RESOURCE');
    return { module: DatabaseModule,
      providers: [
        metricsProvider(options.metrics),
        ...(uow ? [] : [
          { provide: resource, useFactory: async () => {
            const url = process.env['DATABASE_URL'];
            const orm = url === undefined ? undefined : await MikroORM.init(databaseConfig(url));
            return { orm, async onApplicationShutdown() { await orm?.close(true); } };
          } },
          { provide: CoreORM, inject: [resource], useFactory: (value: { orm?: MikroORM }) => value.orm ?? null },
        ]),
        uow ? { provide: FINANCIAL_UNIT_OF_WORK, useValue: uow } : {
          provide: FINANCIAL_UNIT_OF_WORK, inject: [CoreORM], useFactory: (orm: MikroORM | null): FinancialUnitOfWork => orm
            ? new PostgresUnitOfWork(orm)
            : { async run() { throw new ServiceUnavailableException(); } },
        },
        uow ? { provide: POSTGRES_HEALTH_PROBE, useValue: async () => { throw new ServiceUnavailableException(); } } : {
          provide: POSTGRES_HEALTH_PROBE, inject: [CoreORM], useFactory: (orm: MikroORM | null) => {
            if (!orm) return async () => { throw new ServiceUnavailableException(); };
            const probe = new PostgresHealthProbe(orm);
            return (signal: AbortSignal) => probe.check(signal);
          },
        },
        ...caseProviders(),
      ], exports: [FINANCIAL_UNIT_OF_WORK, ...cases, POSTGRES_HEALTH_PROBE, OPERATIONAL_METRICS] };
  }
  static forRoot(options: DatabaseMetricsOptions = {}): DynamicModule {
    return { module: DatabaseModule, imports: [MikroOrmModule.forRoot({ ...databaseConfig(), registerRequestContext: false })],
      providers: [
        metricsProvider(options.metrics),
        { provide: FINANCIAL_UNIT_OF_WORK, inject: [CoreORM], useFactory: (orm: MikroORM) => new PostgresUnitOfWork(orm) },
        ...caseProviders(),
      ], exports: [FINANCIAL_UNIT_OF_WORK, ...cases, OPERATIONAL_METRICS] };
  }
}
