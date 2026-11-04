import { Module, type DynamicModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM as CoreORM } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from './config';
import { PostgresUnitOfWork } from './postgres-unit-of-work';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWork } from '../shared/application/financial-store';
import { CreateWalletUseCase } from '../modules/wallets/application/create-wallet.use-case';
import { GetWalletUseCase, ListWalletLedgerUseCase, ReconcileWalletUseCase } from '../modules/wallets/application/wallet-queries';
import { ProcessWagerTransactionUseCase } from '../modules/wagering/application/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../modules/wagering/application/get-wager-transaction.use-case';

const cases = [CreateWalletUseCase, GetWalletUseCase, ListWalletLedgerUseCase, ReconcileWalletUseCase, ProcessWagerTransactionUseCase, GetWagerTransactionUseCase];
@Module({})
export class DatabaseModule {
  static forRoot(): DynamicModule {
    return { module: DatabaseModule, imports: [MikroOrmModule.forRoot({ ...databaseConfig(), registerRequestContext: false })],
      providers: [
        { provide: FINANCIAL_UNIT_OF_WORK, inject: [CoreORM], useFactory: (orm: MikroORM) => new PostgresUnitOfWork(orm) },
        ...cases.map(useCase => ({ provide: useCase, inject: [FINANCIAL_UNIT_OF_WORK], useFactory: (uow: FinancialUnitOfWork) => new useCase(uow) })),
      ], exports: [FINANCIAL_UNIT_OF_WORK, ...cases] };
  }
}
