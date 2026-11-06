import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { entities } from './entities';
import { Migration202611040001 } from './migrations/Migration202611040001';
import { Migration202611060001 } from './migrations/Migration202611060001';

export function databaseConfig(clientUrl = process.env['DATABASE_URL'], schema = 'public') {
  if (!clientUrl) throw new Error('DATABASE_URL is required');
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema');
  return defineConfig({ clientUrl, schema, entities, extensions: [Migrator],
    allowGlobalContext: false, pool: { min: 0, max: 10 },
    driverOptions: { connection: { application_name: 'jungle', connectionTimeoutMillis: 5000, options: `-c search_path=${schema},public` } },
    migrations: { migrationsList: [Migration202611040001, Migration202611060001], transactional: true, allOrNothing: true, snapshot: false },
  });
}
