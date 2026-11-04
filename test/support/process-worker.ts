import { createInterface } from 'node:readline';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/database/config';
import { PostgresUnitOfWork } from '../../src/database/postgres-unit-of-work';
import { ProcessWagerTransactionUseCase, type ProcessWagerInput } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { testDatabaseUrl } from './postgres';

const schema = process.env['JUNGLE_TEST_SCHEMA'] ?? '';
if (!/^jungle_it_[a-f0-9]{32}$/.test(schema)) throw new Error('Expected owned integration schema');
const orm = await MikroORM.init(databaseConfig(testDatabaseUrl(), schema));
const uow = new PostgresUnitOfWork(orm);
const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const backend = await orm.em.execute<{ pid: number }[]>('select pg_backend_pid() as pid');
reply({ type: 'ready', pid: process.pid, backendPid: backend[0]?.pid });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line: string) => {
  void (async () => {
    const command = JSON.parse(line) as { id: string; input?: ProcessWagerInput; mode?: 'exit-before-commit' | 'exit-after-commit'; type: 'run' | 'close' };
    if (command.type === 'close') { await orm.close(true); process.exit(0); }
    if (!command.input) throw new Error('Missing input');
    const input: ProcessWagerInput = { ...command.input, ...(command.input.inbox ? { inbox: { ...command.input.inbox, receivedAt: new Date(command.input.inbox.receivedAt) } } : {}) };
    try {
      const processor = new ProcessWagerTransactionUseCase(uow, { checkpoint: async phase => {
        if (phase === 'beforeCommit' && command.mode === 'exit-before-commit') process.exit(17);
      } });
      const result = await processor.execute(input);
      if (command.mode === 'exit-after-commit') process.exit(18);
      reply({ type: 'result', id: command.id, ok: true, result });
    } catch (error) { reply({ type: 'result', id: command.id, ok: false, error: error instanceof Error ? error.name : 'UnknownError' }); }
  })().catch(async error => { console.error(error instanceof Error ? error.name : 'WorkerProtocolError'); await orm.close(true); process.exit(1); });
});
