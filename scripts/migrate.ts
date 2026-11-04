import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../src/database/config';

const command = process.argv[2] ?? 'up';
if (!['up', 'down'].includes(command)) throw new Error('Expected up or down');
if (command === 'down' && process.env['JUNGLE_ALLOW_SCHEMA_ROLLBACK'] !== 'yes') {
  throw new Error('Schema rollback loses data. Explicitly set JUNGLE_ALLOW_SCHEMA_ROLLBACK=yes for an authorized disposable database.');
}
const orm = await MikroORM.init(databaseConfig());
try {
  const migrator = orm.getMigrator();
  if (command === 'up') await migrator.up(); else await migrator.down();
  console.log(`Migration ${command} complete`);
} finally { await orm.close(true); }
