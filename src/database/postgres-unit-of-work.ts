import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialUnitOfWork, FinancialStore } from '../shared/application/financial-store';
import { PostgresFinancialStore } from './postgres-financial-store';

export class PostgresUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly orm: MikroORM) {}
  async run<T>(work: (store: FinancialStore) => Promise<T>, isolation: 'read committed' | 'repeatable read' = 'read committed'): Promise<T> {
    const fork = this.orm.em.fork({ clear: true, useContext: false });
    return fork.transactional(async em => {
      await em.execute("set local lock_timeout='2s'");
      await em.execute("set local statement_timeout='10s'");
      return work(new PostgresFinancialStore(em));
    }, { isolationLevel: isolation === 'repeatable read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED });
  }
}
