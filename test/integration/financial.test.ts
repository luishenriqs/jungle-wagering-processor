import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, request, type Harness } from '../support/postgres';
import { ConflictError, NotFoundError } from '../../src/shared/application/application-errors';
import { RetryExhaustedError } from '../../src/shared/application/application-errors';
import { IdempotencyConflictError } from '../../src/shared/domain/domain-errors';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ListWalletLedgerUseCase } from '../../src/modules/wallets/application/wallet-queries';
import { GetWagerTransactionUseCase } from '../../src/modules/wagering/application/get-wager-transaction.use-case';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode as F } from '../../src/modules/wagering/domain/failure-code';
import type { Checkpoint } from '../../src/shared/application/execution';

let h: Harness;
beforeAll(async () => { h = await createHarness(); }, 30000);
afterAll(async () => { if (h) await h.close(); });
afterEach(async () => {
  if (!h) return;
  const bad = await h.orm.em.execute("select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id=w.id group by w.id having w.balance <> coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0)");
  expect(bad).toEqual([]);
});

test('text playerId and UUID playerId roundtrip; opening positive/zero and duplicate wallet', async () => {
  for (const playerId of ['player-test-01', randomUUID()]) {
    const w = await h.wallet('100.00', playerId);
    const stored = await h.get.execute(w.id);
    expect(stored.playerId).toBe(playerId);
    expect(stored.version).toBe(1);
    expect((await h.reconcile.execute(w.id)).checkedEntries).toBe(1);
    await expect(h.wallet('0.00', playerId)).rejects.toBeInstanceOf(ConflictError);
  }
  const zero = await h.wallet('0.00');
  expect((await h.reconcile.execute(zero.id)).checkedEntries).toBe(0);
  const events = await h.orm.em.execute<{ event_type: string }[]>('select event_type from outbox_messages where aggregate_id=?', [zero.id]);
  expect(events).toHaveLength(0);
});
test('two concurrent BETs of 80 over 100 produce one debit, one rejection, version 2', async () => {
  const w = await h.wallet();
  const results = await Promise.all([1, 2].map(() => h.process.execute(request(w, { money: { amount: '80.00', currency: 'BRL' } }))));
  expect(results.filter(r => r.status === S.Processed)).toHaveLength(1);
  expect(results.filter(r => r.failureCode === F.InsufficientFundsBet)).toHaveLength(1);
  expect((await h.get.execute(w.id)).balance.toString()).toBe('20.00');
  expect((await h.get.execute(w.id)).version).toBe(2);
  expect((await h.reconcile.execute(w.id)).checkedEntries).toBe(2);
});
test('50 identical concurrent requests: one original, 49 replays, same historical balance', async () => {
  const w = await h.wallet(); const input = request(w);
  const results = await Promise.all(Array.from({ length: 50 }, () => h.process.execute(input)));
  expect(results.filter(r => !r.idempotentReplay)).toHaveLength(1);
  expect(results.filter(r => r.idempotentReplay)).toHaveLength(49);
  expect(new Set(results.map(r => r.transactionId)).size).toBe(1);
  expect(results.every(r => r.balance.amount === '90.00')).toBe(true);
  expect((await h.get.execute(w.id)).version).toBe(2);
}, 30000);
test('idempotency conflicts have precedence over a different existing or nonexistent wallet', async () => {
  const w = await h.wallet(); const other = await h.wallet(); const input = request(w);
  await h.process.execute(input);
  for (const walletId of [other.id, randomUUID()]) {
    await expect(h.process.execute({ ...input, walletId })).rejects.toBeInstanceOf(IdempotencyConflictError);
  }
  await expect(h.process.execute(request({ id: randomUUID(), playerId: 'unknown' }))).rejects.toBeInstanceOf(NotFoundError);
  await expect(h.process.execute({ ...input, idempotencyKey: 'different-key' })).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(h.process.execute({ ...input, money: { amount: '20.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect((await h.get.execute(other.id)).balance.toString()).toBe('100.00');
});
test('same key racing across wallets yields one winner, one conflict without touching losing wallet', async () => {
  const a = await h.wallet(); const b = await h.wallet();
  const input = request(a);
  let reached = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const barrierTimeout = setTimeout(release, 3000);
  const racing = new ProcessWagerTransactionUseCase(h.uow, { checkpoint: async phase => {
    if (phase === 'wallet') { if (++reached === 2) release(); await gate; }
  } });
  const outcomes = await Promise.allSettled([racing.execute(input), racing.execute({ ...input, walletId: b.id, playerId: b.playerId })])
    .finally(() => { clearTimeout(barrierTimeout); release(); });
  expect(reached).toBe(2);
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  const failure = outcomes.find(o => o.status === 'rejected');
  expect(failure?.status === 'rejected' && failure.reason instanceof IdempotencyConflictError).toBe(true);
  const balances = await Promise.all([a.id, b.id].map(async id => (await h.get.execute(id)).balance.toString()));
  expect(balances.sort()).toEqual(['100.00', '90.00']);
});
test.each([false, true])('real PostgreSQL 40P01 fault exercises fresh transaction retries; exhausted=%s', async exhaust => {
  const w = await h.wallet();
  await h.orm.em.execute('create sequence jungle_retry_fault');
  await h.orm.em.execute(`create function jungle_retry_abort() returns trigger as $$ begin
    if nextval('${h.schema}.jungle_retry_fault') <= ${exhaust ? 10 : 2} then
      raise exception 'injected PostgreSQL transaction abort' using errcode='40P01';
    end if; return NEW; end; $$ language plpgsql`);
  await h.orm.em.execute('create trigger aaa_retry_fault before update on wallets for each row execute function jungle_retry_abort()');
  try {
    const input = request(w, { inbox: { consumerName: 'retry-fault', messageId: randomUUID(), receivedAt: new Date() } });
    if (exhaust) {
      await expect(h.process.execute(input)).rejects.toBeInstanceOf(RetryExhaustedError);
      expect((await h.get.execute(w.id)).balance.toString()).toBe('100.00');
      expect((await h.get.execute(w.id)).version).toBe(1);
      expect(await h.orm.em.execute('select * from inbox_messages where message_id=?', [input.inbox!.messageId])).toHaveLength(0);
    } else {
      const result = await h.process.execute(input);
      expect(result.balance.amount).toBe('90.00');
      expect((await h.get.execute(w.id)).version).toBe(2);
      expect((await h.reconcile.execute(w.id)).checkedEntries).toBe(2);
    }
    const sequence = await h.orm.em.execute<{ last_value: string }[]>('select last_value::text from jungle_retry_fault');
    expect(sequence[0]?.last_value).toBe('3');
  } finally {
    await h.orm.em.execute('drop trigger aaa_retry_fault on wallets');
    await h.orm.em.execute('drop function jungle_retry_abort()');
    await h.orm.em.execute('drop sequence jungle_retry_fault');
  }
});
test('rejected and pending replay preserve snapshots after a later wallet movement', async () => {
  const w = await h.wallet('0.00'); const bet = request(w);
  const rejected = await h.process.execute(bet);
  const pendingInput = request(w, { kind: K.Refund, referenceExternalTransactionId: 'not-arrived' });
  const pending = await h.process.execute(pendingInput);
  await h.process.execute(request(w, { kind: K.Win, money: { amount: '100.00', currency: 'BRL' } }));
  expect(await h.process.execute(bet)).toEqual({ ...rejected, idempotentReplay: true });
  expect(await h.process.execute(pendingInput)).toEqual({ ...pending, idempotentReplay: true });
  expect(rejected.balance.amount).toBe('0.00');
  expect(pending.status).toBe(S.PendingReference);
});
test('currency mismatch is auditably rejected with the wallet currency snapshot', async () => {
  const w = await h.wallet();
  const result = await h.process.execute(request(w, { money: { amount: '10.00', currency: 'USD' } }));
  expect(result.failureCode).toBe(F.CurrencyMismatch);
  expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  expect((await h.get.execute(w.id)).version).toBe(1);
});
test('Inbox redelivery, new message for replay and conflicting payload', async () => {
  const w = await h.wallet();
  const input = request(w, { inbox: { consumerName: 'consumer', messageId: randomUUID(), receivedAt: new Date() } });
  const results = await Promise.all([h.process.execute(input), h.process.execute(input)]);
  expect(results.filter(r => r.idempotentReplay)).toHaveLength(1);
  await h.process.execute({ ...input, inbox: { ...input.inbox!, messageId: randomUUID() } });
  await expect(h.process.execute({ ...input, money: { amount: '11.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);
  const messages = await h.orm.em.execute<{ processed_at: Date | null }[]>('select processed_at from inbox_messages where payload_hash=(select payload_hash from wager_transactions where id=?)', [results[0]!.transactionId]);
  expect(messages).toHaveLength(2);
  expect(messages.every(m => m.processed_at !== null)).toBe(true);
  expect((await h.get.execute(w.id)).balance.toString()).toBe('90.00');
});
test('same Inbox message racing across different wallets cannot apply both payloads', async () => {
  const a = await h.wallet(); const b = await h.wallet();
  const inbox = { consumerName: 'consumer', messageId: randomUUID(), receivedAt: new Date() };
  const results = await Promise.allSettled([h.process.execute(request(a, { inbox })), h.process.execute(request(b, { inbox }))]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(r => r.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason instanceof IdempotencyConflictError).toBe(true);
});
test.each(['wallet', 'wager', 'ledger', 'outbox', 'inbox', 'beforeCommit'] as const)('failure at %s rolls back all five tables', async phase => {
  const w = await h.wallet(); const input = request(w, { inbox: { consumerName: 'faults', messageId: randomUUID(), receivedAt: new Date() } });
  const faulty = new ProcessWagerTransactionUseCase(h.uow, { checkpoint: async actual => { if (actual === phase) throw new Error(`fault-${phase}`); } });
  await expect(faulty.execute(input)).rejects.toThrow(`fault-${phase}`);
  const wallet = await h.get.execute(w.id);
  expect(wallet.balance.toString()).toBe('100.00'); expect(wallet.version).toBe(1);
  expect(await h.orm.em.execute('select id from wager_transactions where idempotency_key=?', [input.idempotencyKey])).toHaveLength(0);
  expect(await h.orm.em.execute('select * from inbox_messages where consumer_name=? and message_id=?', [input.inbox!.consumerName, input.inbox!.messageId])).toHaveLength(0);
  expect(await h.orm.em.execute('select id from wallet_ledger_entries where wallet_id=?', [w.id])).toHaveLength(1);
  expect(await h.orm.em.execute('select id from outbox_messages where aggregate_id=?', [w.id])).toHaveLength(2);
  expect((await h.process.execute(input)).idempotentReplay).toBe(false);
});
test.each(['wallet', 'wager', 'ledger', 'outbox', 'beforeCommit'] as Checkpoint[])('creation failure at %s leaves no opening artifacts', async phase => {
  const playerId = randomUUID(); const id = randomUUID();
  // Distinct event IDs are part of the opening contract; supply a sequence.
  let ordinal = 0;
  const failing = new CreateWalletUseCase(h.uow, { newId: () => ordinal++ === 0 ? id : randomUUID(), checkpoint: async actual => { if (actual === phase) throw new Error('opening-fault'); } });
  await expect(failing.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: randomUUID() })).rejects.toThrow('opening-fault');
  for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages']) {
    const column = table === 'wallets' ? 'id' : table === 'outbox_messages' ? 'aggregate_id' : 'wallet_id';
    expect(await h.orm.em.execute(`select * from ${table} where ${column}=?`, [id])).toHaveLength(0);
  }
});
test('REFUND/ROLLBACK race, chained reversal and insufficient reversal rejection', async () => {
  const w = await h.wallet(); const bet = request(w);
  await h.process.execute(bet);
  const refund = request(w, { kind: K.Refund, referenceExternalTransactionId: bet.externalTransactionId });
  const rollback = request(w, { kind: K.Rollback, referenceExternalTransactionId: bet.externalTransactionId });
  const results = await Promise.all([h.process.execute(refund), h.process.execute(rollback)]);
  expect(results.filter(r => r.status === S.Processed)).toHaveLength(1);
  expect(results.filter(r => r.failureCode === F.ReferenceAlreadyReversed)).toHaveLength(1);
  expect((await h.get.execute(w.id)).balance.toString()).toBe('100.00');
  const second = await h.wallet(); const secondBet = request(second); await h.process.execute(secondBet);
  const secondRefund = request(second, { kind: K.Refund, referenceExternalTransactionId: secondBet.externalTransactionId }); await h.process.execute(secondRefund);
  const chained = await h.process.execute(request(second, { kind: K.Rollback, referenceExternalTransactionId: secondRefund.externalTransactionId }));
  expect(chained.balance.amount).toBe('90.00');
  const zero = await h.wallet('0.00'); const win = request(zero, { kind: K.Win }); await h.process.execute(win); await h.process.execute(request(zero));
  const rejected = await h.process.execute(request(zero, { kind: K.Rollback, referenceExternalTransactionId: win.externalTransactionId }));
  expect(rejected.failureCode).toBe(F.InsufficientFundsReversal);
});
test('queries and stable cursor paginate >120 entries with identical timestamps', async () => {
  const w = await h.wallet('0.00');
  const fixed = new Date('2026-11-04T12:00:00Z');
  const processor = new ProcessWagerTransactionUseCase(h.uow, { now: () => fixed });
  let lastId = '';
  for (let i = 0; i < 121; i++) lastId = (await processor.execute(request(w, { kind: K.Win, money: { amount: '1.00', currency: 'BRL' } }))).transactionId;
  const reader = new ListWalletLedgerUseCase(h.uow); const ids: string[] = []; let cursor: string | undefined;
  do {
    const page = await reader.execute({ walletId: w.id, limit: 50, ...(cursor ? { cursor } : {}) });
    ids.push(...page.entries.map(e => e.id)); cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(121); expect(new Set(ids).size).toBe(121);
  const query = new GetWagerTransactionUseCase(h.uow);
  const tx = await query.execute({ id: lastId });
  expect((await query.execute({ providerId: tx.providerId, externalTransactionId: tx.externalTransactionId })).id).toBe(lastId);
  await expect(reader.execute({ walletId: w.id, cursor: 'invalid' })).rejects.toThrow();
}, 30000);
