import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/database/config';
import { PostgresUnitOfWork } from '../../src/database/postgres-unit-of-work';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase, type ProcessWagerInput } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { GetWalletUseCase, ReconcileWalletUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';

export function testDatabaseUrl(): string {
  const value = process.env['TEST_DATABASE_URL'];
  if (!value) throw new Error('TEST_DATABASE_URL is required: integration tests need real Jungle PostgreSQL 16');
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.pathname !== '/jungle_test') {
    throw new Error('Integration tests are restricted to database jungle_test; never use development or another project database');
  }
  return value;
}
export async function createHarness() {
  const url = testDatabaseUrl();
  const schema = `jungle_it_${randomUUID().replaceAll('-', '')}`;
  const orm = await MikroORM.init(databaseConfig(url, schema));
  let created = false;
  try {
    const version = await orm.em.getConnection().execute<{ server_version_num: string }[]>('show server_version_num');
    if (!version[0]?.server_version_num.startsWith('16')) throw new Error('Integration requires PostgreSQL 16');
    await orm.em.getConnection().execute(`create schema "${schema}"`);
    created = true;
    await orm.getMigrator().up();
  } catch (error) {
    try { if (created) await orm.em.getConnection().execute(`drop schema "${schema}" cascade`); }
    finally { await orm.close(true); }
    throw error;
  }
  const uow = new PostgresUnitOfWork(orm);
  return { orm, uow, schema, url, create: new CreateWalletUseCase(uow), process: new ProcessWagerTransactionUseCase(uow),
    get: new GetWalletUseCase(uow), reconcile: new ReconcileWalletUseCase(uow),
    async wallet(amount = '100.00', playerId = `player-test-01-${randomUUID()}`) {
      return new CreateWalletUseCase(uow).execute({ playerId, initialBalance: { amount, currency: 'BRL' }, correlationId: randomUUID() });
    },
    async close() {
      if (!/^jungle_it_[a-f0-9]{32}$/.test(schema)) throw new Error('Refusing to drop non-test schema');
      try { await orm.em.getConnection().execute(`drop schema "${schema}" cascade`); } finally { await orm.close(true); }
    },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
export function request(wallet: { id: string; playerId: string }, overrides: Partial<ProcessWagerInput> = {}): ProcessWagerInput {
  const external = randomUUID();
  return { walletId: wallet.id, playerId: wallet.playerId, providerId: 'provider-test', externalTransactionId: external,
    idempotencyKey: `provider-test:${external}`, roundId: 'round-test', gameId: 'game-test', kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' }, correlationId: randomUUID(), ...overrides };
}
