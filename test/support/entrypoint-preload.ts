import { MikroORM } from '@mikro-orm/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { entrypointIsolation } from './entrypoint-isolation';

// Test-only configuration/observation. The actual production script, DynamicModules,
// providers, SDK, PostgreSQL transactions and shutdown hooks remain in use.
const emit = (phase: string) => console.log(JSON.stringify({ component: 'entrypoint-test', phase }));
try {
  const { url, schema } = entrypointIsolation(process.env);
  const init = MikroORM.init.bind(MikroORM);
  MikroORM.init = (async (options: Parameters<typeof MikroORM.init>[0]) => {
    if (!options || options.clientUrl !== url) throw new Error('Unexpected entrypoint database configuration');
    const orm = await init({ ...options, schema,
      driverOptions: { ...options.driverOptions, connection: { ...options.driverOptions?.connection,
        options: `-c search_path=${schema}`, application_name: `jungle-smoke-${schema}` } } });
    try {
      const [identity] = await orm.em.getConnection().execute<{ db: string; schema: string }[]>(
        'select current_database() as db,current_schema() as schema');
      const [tables] = await orm.em.getConnection().execute<{ n: string }[]>(`select count(*)::text as n
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=? and c.relkind='r'
        and c.relname in ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')`, [schema]);
      if (identity?.db !== 'jungle_test' || identity.schema !== schema || tables?.n !== '5') throw new Error('Unverified entrypoint schema');
      emit('resources-verified'); // Before Nest receives ORM and before lifecycle loops can start.
      const close = orm.close.bind(orm);
      orm.close = async force => {
        emit('pool-close-started'); await close(force);
        if (await orm.isConnected()) throw new Error('Entrypoint pool remains connected');
        emit('pool-closed');
      };
      return orm;
    } catch {
      await orm.close(true); throw new Error('Entrypoint resource verification failed');
    }
  }) as typeof MikroORM.init;
  const send = SQSClient.prototype.send;
  SQSClient.prototype.send = (function (this: SQSClient, command: object, ...args: unknown[]) {
    const result = Reflect.apply(send, this, [command, ...args]) as Promise<unknown>;
    return result.then(value => {
      if (command.constructor.name === 'DeleteMessageCommand') emit('delete-confirmed');
      return value;
    });
  }) as typeof SQSClient.prototype.send;
  const destroy = SQSClient.prototype.destroy;
  SQSClient.prototype.destroy = function () { destroy.call(this); emit('sqs-closed'); };
} catch {
  console.error(JSON.stringify({ component: 'entrypoint-test', phase: 'isolation-rejected' }));
  process.exit(1);
}
