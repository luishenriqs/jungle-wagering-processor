import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { createHarness, request, type Harness } from '../support/postgres';
import { sqlError } from '../../src/shared/application/application-errors';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';

const baseline = 'Migration202611040001';
const finiteMigration = 'Migration202611060001';
const columns = [
  ['wallets', 'balance', 'ck_wallet_all_finite'],
  ['wager_transactions', 'amount', 'ck_wager_all_finite'],
  ['wager_transactions', 'recorded_balance_amount', 'ck_wager_all_finite'],
  ['wallet_ledger_entries', 'amount', 'ck_ledger_all_finite'],
  ['wallet_ledger_entries', 'balance_before', 'ck_ledger_all_finite'],
  ['wallet_ledger_entries', 'balance_after', 'ck_ledger_all_finite'],
] as const;
type Target = typeof columns[number];

async function isolated(work: (h: Harness) => Promise<void>) {
  const h = await createHarness();
  try {
    expect(await h.orm.em.execute('select current_database() as db,current_schema() as schema'))
      .toEqual([{ db: 'jungle_test', schema: h.schema }]);
    await work(h);
  } finally { await h.close(); }
}

async function legacy(h: Harness) {
  if ((await h.orm.getMigrator().getExecutedMigrations()).some(row => row.name === finiteMigration)) {
    await h.orm.getMigrator().down({ migrations: [finiteMigration] });
  }
}

/** All six NaNs satisfy the old checks together, including the deferred ledger total.
 * This deliberately corrupt bundle belongs only to a disposable legacy test schema. */
async function legacyNanBundle(h: Harness, mode: 'all' | 'ledger-balances' = 'all') {
  const walletId = randomUUID(); const txId = randomUUID();
  const amount = mode === 'all' ? 'NaN' : '1.00';
  await h.orm.em.fork().transactional(async em => {
    await em.execute('insert into wallets(id,player_id,currency,balance) values (?,?,?,?)', [walletId, walletId, 'BRL', amount]);
    await em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,
      wallet_id,player_id,round_id,game_id,kind,amount,currency,status,recorded_balance_amount,recorded_balance_currency,processed_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now())`, [txId, 'SYSTEM', `opening:${walletId}`, `SYSTEM:opening:${walletId}`,
      'a'.repeat(64), walletId, walletId, `opening:${walletId}`, 'SYSTEM_OPENING', 'OPENING', amount, 'BRL', 'PROCESSED', amount, 'BRL']);
    await em.execute(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
      values (?,?,?,'CREDIT',?,'BRL',?,?)`, [randomUUID(), walletId, txId, amount, 'NaN', 'NaN']);
  });
  const rows = await h.orm.em.execute(`select w.balance::text as balance,t.amount::text as wager_amount,
    t.recorded_balance_amount::text as snapshot,l.amount::text as ledger_amount,
    l.balance_before::text as balance_before,l.balance_after::text as balance_after
    from wallets w join wager_transactions t on t.wallet_id=w.id join wallet_ledger_entries l on l.transaction_id=t.id
    where w.id=?`, [walletId]);
  expect(rows).toEqual([{ balance: amount, wager_amount: amount, snapshot: amount, ledger_amount: amount, balance_before: 'NaN', balance_after: 'NaN' }]);
}

/** A fresh identity and otherwise valid financial bundle prevent unique/FK failures
 * from being mistaken for nonfinite-value rejection. Only the selected column changes. */
async function insertTarget(em: EntityManager, target: Target, value: string) {
  const [table, column] = target; const walletId = randomUUID(); const txId = randomUUID();
  await em.execute('insert into wallets(id,player_id,currency,balance) values (?,?,?,?)',
    [walletId, walletId, 'BRL', table === 'wallets' ? value : '1.00']);
  const amount = table === 'wager_transactions' && column === 'amount' ? value : '1.00';
  const snapshot = table === 'wager_transactions' && column === 'recorded_balance_amount' ? value : '1.00';
  await em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,
    wallet_id,player_id,round_id,game_id,kind,amount,currency,status,recorded_balance_amount,recorded_balance_currency,processed_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now())`, [txId, 'SYSTEM', `opening:${walletId}`, `SYSTEM:opening:${walletId}`,
    'a'.repeat(64), walletId, walletId, `opening:${walletId}`, 'SYSTEM_OPENING', 'OPENING', amount, 'BRL', 'PROCESSED', snapshot, 'BRL']);
  await em.execute(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
    values (?,?,?,'CREDIT',?,'BRL',?,?)`, [randomUUID(), walletId, txId,
    table === 'wallet_ledger_entries' && column === 'amount' ? value : '1.00',
    table === 'wallet_ledger_entries' && column === 'balance_before' ? value : '0.00',
    table === 'wallet_ledger_entries' && column === 'balance_after' ? value : '1.00']);
}

test('FIX-D01 inventory covers every persisted financial NUMERIC(18,2) column', () => isolated(async h => {
  const rows = await h.orm.em.execute(`select table_name,column_name,numeric_precision,numeric_scale
    from information_schema.columns where table_schema=? and data_type='numeric' order by table_name,column_name`, [h.schema]);
  expect(rows).toEqual(columns.map(([table_name, column_name]) => ({ table_name, column_name, numeric_precision: 18, numeric_scale: 2 }))
    .sort((a, b) => `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`)));
}));

test('FIX-D01 legacy schema confirms NaN in all six monetary columns at commit', () => isolated(async h => {
  await legacy(h);
  await legacyNanBundle(h);
}));

for (const target of columns) {
  test(`FIX-D01 rejects NaN specifically at ${target[0]}.${target[1]}`, () => isolated(async h => {
    let failure: unknown;
    try { await h.orm.em.fork().transactional(em => insertTarget(em, target, 'NaN')); }
    catch (error) { failure = error; }
    // The named finite check must act, rather than an unrelated arithmetic/deferred check.
    expect(sqlError(failure)).toEqual({ code: '23514', constraint: target[2] });
    for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries']) {
      expect(await h.orm.em.execute(`select id from ${table}`)).toEqual([]);
    }
  }));
  for (const value of ['Infinity', '-Infinity']) {
    test(`FIX-D01 rejects ${value} at ${target[0]}.${target[1]}`, () => isolated(async h => {
      let failure: unknown;
      try { await h.orm.em.fork().transactional(em => insertTarget(em, target, value)); }
      catch (error) { failure = error; }
      // PostgreSQL's NUMERIC typmod rejects infinity before evaluating row checks.
      expect(sqlError(failure).code).toBe('22003');
      expect(await h.orm.em.execute('select id from wallets')).toEqual([]);
    }));
  }
}

for (const amount of ['0.00', '0.01', '9999999999999999.99']) {
  test(`FIX-D01 finite ${amount} preserves financial commits, historical snapshots and reconciliation`, () => isolated(async h => {
    const wallet = await h.wallet(amount);
    expect((await h.get.execute(wallet.id)).balance.toString()).toBe(amount);
    if (amount !== '0.00') {
      const input = request(wallet, { money: { amount, currency: 'BRL' } });
      const debit = await h.process.execute(input);
      expect(debit.balance.amount).toBe('0.00');
      await h.process.execute(request(wallet, { kind: WagerTransactionKind.Win, money: { amount, currency: 'BRL' } }));
      expect(await h.process.execute(input)).toEqual({ ...debit, idempotentReplay: true });
    }
    const result = await h.reconcile.execute(wallet.id);
    expect(result.consistent).toBe(true); expect(result.storedBalance.amount).toBe(amount);
    expect((await h.get.execute(wallet.id)).version).toBe(amount === '0.00' ? 1 : 3);
    // A genuinely absent snapshot remains valid for an unprocessed transaction.
    await h.orm.em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,
      wallet_id,player_id,round_id,game_id,kind,amount,currency,status)
      values (?,'finite-test',?,?,?, ?,?,'round','game','BET',1,'BRL','PENDING')`,
    [randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), wallet.id, wallet.playerId]);
  }));
}

for (const target of columns.filter(([table]) => table !== 'wallet_ledger_entries')) {
  test(`FIX-D01 UPDATE rejects NaN at ${target[0]}.${target[1]} without changing committed data`, () => isolated(async h => {
    const wallet = await h.wallet('1.00'); const txId = randomUUID();
    await h.orm.em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,
      wallet_id,player_id,round_id,game_id,kind,amount,currency,status)
      values (?,'finite-update',?,?,?, ?,?,'round','game','BET',1,'BRL','PENDING')`,
    [txId, randomUUID(), randomUUID(), 'a'.repeat(64), wallet.id, wallet.playerId]);
    let failure: unknown;
    try {
      await h.orm.em.fork().transactional(em => em.execute(target[0] === 'wallets'
        ? "update wallets set balance='NaN',version=version+1 where id=?"
        : `update wager_transactions set ${target[1]}='NaN' where id=?`, [target[0] === 'wallets' ? wallet.id : txId]));
    } catch (error) { failure = error; }
    // Wager amount is already immutable, even in PENDING: its BEFORE trigger must remain authoritative.
    expect(sqlError(failure)).toEqual(target[0] === 'wager_transactions' && target[1] === 'amount'
      ? { code: '55000' } : { code: '23514', constraint: target[2] });
    expect((await h.get.execute(wallet.id)).balance.toString()).toBe('1.00');
    expect((await h.get.execute(wallet.id)).version).toBe(1);
    expect(await h.orm.em.execute('select amount::text,recorded_balance_amount from wager_transactions where id=?', [txId]))
      .toEqual([{ amount: '1.00', recorded_balance_amount: null }]);
    expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
  }));
}

async function finiteChecks(h: Harness) {
  return h.orm.em.execute<{ conname: string; convalidated: boolean }[]>(`select conname,convalidated from pg_constraint c
    join pg_namespace n on n.oid=c.connamespace where n.nspname=?
    and conname in ('ck_wallet_all_finite','ck_wager_all_finite','ck_ledger_all_finite') order by conname`, [h.schema]);
}

test('FIX-D01 new migration UP/DOWN/UP preserves data, old constraints and reconciliation', () => isolated(async h => {
  const wallet = await h.wallet('9999999999999999.99');
  const before = await h.orm.em.execute('select * from wallets where id=?', [wallet.id]);
  expect(await finiteChecks(h)).toEqual(['ck_ledger_all_finite', 'ck_wager_all_finite', 'ck_wallet_all_finite']
    .map(conname => ({ conname, convalidated: true })));
  await h.orm.getMigrator().down({ migrations: [finiteMigration] });
  expect(await finiteChecks(h)).toEqual([]);
  expect((await h.orm.getMigrator().getExecutedMigrations()).map(row => row.name)).toEqual([baseline]);
  expect(await h.orm.em.execute('select * from wallets where id=?', [wallet.id])).toEqual(before);
  expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
  let immutable: unknown;
  try { await h.orm.em.execute('delete from wallet_ledger_entries where wallet_id=?', [wallet.id]); }
  catch (error) { immutable = error; }
  expect(sqlError(immutable).code).toBe('55000');
  await h.orm.getMigrator().up();
  expect((await h.orm.getMigrator().getExecutedMigrations()).map(row => row.name)).toEqual([baseline, finiteMigration]);
  expect(await finiteChecks(h)).toHaveLength(3);
  expect((await finiteChecks(h)).every(row => row.convalidated)).toBe(true);
  expect(await h.orm.em.execute('select * from wallets where id=?', [wallet.id])).toEqual(before);
  let failure: unknown;
  try { await h.orm.em.fork().transactional(em => insertTarget(em, columns[2], 'NaN')); }
  catch (error) { failure = error; }
  expect(sqlError(failure)).toEqual({ code: '23514', constraint: 'ck_wager_all_finite' });
  expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
}));

test('FIX-D01 upgrading legacy NaN fails atomically without rewriting financial history', () => isolated(async h => {
  await legacy(h); await legacyNanBundle(h);
  let failure: unknown;
  try { await h.orm.getMigrator().up(); } catch (error) { failure = error; }
  expect(sqlError(failure)).toEqual({ code: '23514', constraint: 'ck_wallet_all_finite' });
  expect(await finiteChecks(h)).toEqual([]);
  expect((await h.orm.getMigrator().getExecutedMigrations()).map(row => row.name)).toEqual([baseline]);
  expect(await h.orm.em.execute('select balance::text from wallets')).toEqual([{ balance: 'NaN' }]);
  expect(await h.orm.em.execute('select amount::text,balance_before::text,balance_after::text from wallet_ledger_entries'))
    .toEqual([{ amount: 'NaN', balance_before: 'NaN', balance_after: 'NaN' }]);
}));

for (const column of ['amount', 'recorded_balance_amount', 'ledger-balances'] as const) {
  test(`FIX-D01 upgrading legacy ${column} NaN rolls back checks already added to earlier tables`, () => isolated(async h => {
    await legacy(h);
    if (column === 'ledger-balances') await legacyNanBundle(h, column);
    else {
      const wallet = await h.wallet('0.00');
      await h.orm.em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,
        wallet_id,player_id,round_id,game_id,kind,amount,currency,status,recorded_balance_amount,recorded_balance_currency)
        values (?,'legacy-nan',?,?,?, ?,?,'round','game','BET',?,'BRL','PENDING',?,'BRL')`,
      [randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), wallet.id, wallet.playerId,
        column === 'amount' ? 'NaN' : '1.00', column === 'recorded_balance_amount' ? 'NaN' : '0.00']);
    }
    const before = await h.orm.em.execute('select * from wager_transactions');
    const ledgerBefore = await h.orm.em.execute('select * from wallet_ledger_entries');
    let failure: unknown;
    try { await h.orm.getMigrator().up(); } catch (error) { failure = error; }
    expect(sqlError(failure)).toEqual({ code: '23514', constraint: column === 'ledger-balances' ? 'ck_ledger_all_finite' : 'ck_wager_all_finite' });
    expect(await finiteChecks(h)).toEqual([]);
    expect((await h.orm.getMigrator().getExecutedMigrations()).map(row => row.name)).toEqual([baseline]);
    expect(await h.orm.em.execute('select * from wager_transactions')).toEqual(before);
    expect(await h.orm.em.execute('select * from wallet_ledger_entries')).toEqual(ledgerBefore);
  }));
}
