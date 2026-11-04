import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, request, type Harness } from '../support/postgres';
import { sqlError } from '../../src/shared/application/application-errors';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';

let h: Harness;
beforeAll(async () => { h = await createHarness(); }, 30000);
afterAll(async () => { if (h) await h.close(); });
async function rejected(sql: string, params: unknown[], code: string) {
  let failure: unknown;
  try { await h.orm.em.fork().transactional(em => em.execute(sql, params)); } catch (error) { failure = error; }
  expect(sqlError(failure).code).toBe(code);
}
test('migration up/down/up in the newly-created isolated test schema', async () => {
  await h.orm.getMigrator().down({ to: 0 });
  const absent = await h.orm.em.execute<{ name: string | null }[]>(`select to_regclass('${h.schema}.wallets')::text as name`);
  expect(absent[0]?.name).toBeNull();
  await h.orm.getMigrator().up();
  const names = await h.orm.em.execute<{ tablename: string }[]>('select tablename from pg_tables where schemaname=?', [h.schema]);
  expect(names.map(n => n.tablename)).toEqual(expect.arrayContaining(['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages']));
  const indexes = await h.orm.em.execute<{ indexname: string }[]>('select indexname from pg_indexes where schemaname=?', [h.schema]);
  expect(indexes.map(i => i.indexname)).toEqual(expect.arrayContaining(['uq_wager_processed_reversal', 'uq_wager_idempotency', 'uq_wager_provider_external', 'idx_ledger_wallet_cursor', 'idx_outbox_due']));
  const triggers = await h.orm.em.execute<{ tgname: string }[]>('select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=? and not t.tgisinternal', [h.schema]);
  expect(triggers.map(t => t.tgname)).toEqual(expect.arrayContaining(['trg_ledger_immutable', 'trg_wager_terminal', 'trg_wallet_ledger_total', 'trg_wager_effect']));
});
test('database rejects negative balance, version changes and balance without ledger', async () => {
  const w = await h.wallet('0.00');
  await rejected('update wallets set balance=-1 where id=?', [w.id], '23514');
  await rejected('update wallets set version=0 where id=?', [w.id], '23514');
  await rejected('update wallets set balance=10,version=2 where id=?', [w.id], '23514');
  expect((await h.get.execute(w.id)).balance.toString()).toBe('0.00');
});
test('database rejects UPDATE/DELETE ledger and mutation/deletion of terminal wager', async () => {
  const w = await h.wallet();
  await rejected('update wallet_ledger_entries set amount=amount where wallet_id=?', [w.id], '55000');
  await rejected('delete from wallet_ledger_entries where wallet_id=?', [w.id], '55000');
  await rejected('update wager_transactions set status=status where wallet_id=?', [w.id], '55000');
  await rejected('delete from wager_transactions where wallet_id=?', [w.id], '55000');
});
test('ledger amount, arithmetic, currency, FK and uniqueness constraints reject direct SQL', async () => {
  const w = await h.wallet();
  const source = 'select ?,wallet_id,transaction_id,direction,AMOUNT,currency,balance_before,BALANCE_AFTER,created_at from wallet_ledger_entries where wallet_id=?';
  const insert = 'insert into wallet_ledger_entries (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at) ';
  await rejected(insert + source.replace('AMOUNT', '0').replace('BALANCE_AFTER', 'balance_after'), [randomUUID(), w.id], '23514');
  await rejected(insert + source.replace('AMOUNT', 'amount').replace('BALANCE_AFTER', 'balance_after+1'), [randomUUID(), w.id], '23514');
  await rejected(insert + source.replace('AMOUNT', 'amount').replace('BALANCE_AFTER', 'balance_after'), [randomUUID(), w.id], '23505');
  await rejected('insert into wallet_ledger_entries values (?,?,?,\'CREDIT\',1,\'BRL\',0,1,now())', [randomUUID(), randomUUID(), randomUUID()], '23503');
});
test('processed wager without a corresponding ledger cannot commit', async () => {
  const w = await h.wallet();
  const original = await h.process.execute(request(w, { kind: WagerTransactionKind.Loss, money: { amount: '0.00', currency: 'BRL' } }));
  // Copy the nonfinancial terminal row as a financial row with fresh business identity, but no ledger.
  await rejected(`insert into wager_transactions
    (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,recorded_balance_amount,recorded_balance_currency,created_at,processed_at)
    select ?,provider_id,?,?,payload_hash,wallet_id,player_id,round_id,game_id,'WIN',1,currency,'PROCESSED',recorded_balance_amount,recorded_balance_currency,created_at,processed_at from wager_transactions where id=?`,
    [randomUUID(), randomUUID(), randomUUID(), original.transactionId], '23514');
});
test('REJECTED and FAILED require failure codes and response snapshots', async () => {
  const w = await h.wallet();
  for (const status of ['REJECTED', 'FAILED']) {
    await rejected(`insert into wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status)
      values (?,'provider',?,? ,?, ?,?,'round','game','BET',1,'BRL',?)`, [randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), w.id, w.playerId, status], '23514');
  }
});
test('Inbox unique key and all-or-none Outbox lease fields are schema enforced', async () => {
  const w = await h.wallet();
  const messageId = randomUUID();
  await h.process.execute(request(w, { inbox: { consumerName: 'schema', messageId, receivedAt: new Date() } }));
  await rejected("insert into inbox_messages values ('schema',?,?,now(),now())", [messageId, 'a'.repeat(64)], '23505');
  await rejected('update outbox_messages set lease_owner=? where aggregate_id=?', ['owner', w.id], '23514');
});
test('NUMERIC driver values remain strings at the maximum supported amount', async () => {
  const w = await h.wallet('9999999999999999.99');
  const rows = await h.orm.em.execute<{ balance: string }[]>('select balance from wallets where id=?', [w.id]);
  expect(typeof rows[0]?.balance).toBe('string');
  expect(rows[0]?.balance).toBe('9999999999999999.99');
});
test('partial unique index blocks crossed processed reversals even through direct SQL', async () => {
  const w = await h.wallet(); const bet = request(w); await h.process.execute(bet);
  const refund = await h.process.execute(request(w, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
  await rejected(`insert into wager_transactions
    (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id,reference_transaction_id,recorded_balance_amount,recorded_balance_currency,created_at,processed_at)
    select ?,provider_id,?,?,payload_hash,wallet_id,player_id,round_id,game_id,'ROLLBACK',amount,currency,status,reference_external_transaction_id,reference_transaction_id,recorded_balance_amount,recorded_balance_currency,created_at,processed_at from wager_transactions where id=?`,
    [randomUUID(), randomUUID(), randomUUID(), refund.transactionId], '23505');
});
