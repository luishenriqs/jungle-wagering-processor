import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, request, type Harness } from '../support/postgres';
import { pendingWorkerChild } from '../support/pending-worker-client';
import { processClient } from '../support/process-client';
import { sqlError } from '../../src/shared/application/application-errors';
import { PendingReferenceWorker, type PendingCandidate, type PendingResolution } from '../../src/modules/wagering/application/pending-reference-worker';
import { pendingReferencePolicy, type PendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { ProcessWagerTransactionUseCase, type ProcessWagerInput } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import type { Checkpoint } from '../../src/shared/application/execution';

const epoch = new Date('2035-01-01T00:00:00Z');
let context: { pg: Harness; now: Date } | undefined;
beforeEach(async () => { context = { pg: await createHarness(), now: new Date(epoch) }; }, 30000);
afterEach(async () => { const h = context; context = undefined; if (h) await h.pg.close(); });
function ctx() { if (!context) throw new Error('Real PostgreSQL is required'); return context; }
const policy = pendingReferencePolicy({});
function processor(p = policy) { return new ProcessWagerTransactionUseCase(ctx().pg.uow, { now: () => ctx().now, pendingReferencePolicy: p }); }
function worker(p = policy, checkpoint?: (phase: Checkpoint) => Promise<void>) {
  return new PendingReferenceWorker(ctx().pg.uow, { now: () => ctx().now }, p, { ...(checkpoint ? { checkpoint } : {}), diagnose: () => {} });
}
async function get(id: string) { return ctx().pg.uow.run(s => s.getWager(id)); }
async function seed(p = policy) {
  const wallet = await ctx().pg.wallet(); const bet = request(wallet);
  const refund = request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId,
    inbox: { consumerName: 'pending-integration', messageId: randomUUID(), receivedAt: epoch } });
  const accepted = await processor(p).execute(refund);
  expect(accepted.status).toBe(WagerTransactionStatus.PendingReference);
  return { wallet, bet, refund, accepted, candidate: { walletId: wallet.id, id: accepted.transactionId } };
}
async function snapshot(walletId: string) {
  const h = ctx();
  const [counts] = await h.pg.orm.em.fork().execute<{ ledger: string; outbox: string; inbox: string; wager: string }[]>(`select
    (select count(*)::text from wallet_ledger_entries where wallet_id=?) as ledger,
    (select count(*)::text from outbox_messages where aggregate_id=?) as outbox,
    (select count(*)::text from inbox_messages where processed_at is not null) as inbox,
    (select count(*)::text from wager_transactions where wallet_id=?) as wager`, [walletId, walletId, walletId]);
  const wallet = await h.pg.get.execute(walletId);
  return { ...counts, balance: wallet.balance.toString(), version: wallet.version };
}
async function reconcile(walletId: string, amount: string) {
  const result = await ctx().pg.reconcile.execute(walletId);
  expect(result.consistent).toBe(true); expect(result.storedBalance.amount).toBe(amount);
}
async function runThree(p = policy, candidate?: PendingCandidate, concurrent?: () => Promise<unknown>) {
  const h = ctx(); const children: Awaited<ReturnType<typeof pendingWorkerChild>>[] = [];
  try {
    for (let i = 0; i < 3; i++) children.push(await pendingWorkerChild(h.pg, h.now, p, candidate));
    expect(new Set(children.map(c => c.pid)).size).toBe(3); expect(new Set(children.map(c => c.backendPid)).size).toBe(3);
    expect(children.every(c => Number.isInteger(c.backendPid))).toBe(true);
    console.log('CP-04 process identities:', JSON.stringify(children.map(c => ({ pid: c.pid, backendPid: c.backendPid }))));
    children.forEach(c => c.start());
    const [codes] = await Promise.all([Promise.all(children.map(c => c.done)), concurrent?.()]);
    expect(codes).toEqual([0, 0, 0]);
    return children.flatMap(c => c.records).filter(r => r.type === 'done').flatMap(r => r.results ?? []);
  } finally { await Promise.all(children.map(c => c.close())); }
}

test('configured acceptance schedule resolves a late BET atomically and preserves historical replay', async () => {
  const h = ctx(); const p = { baseDelayMs: 20, maxAttempts: 3, ttlMs: 500 }; const s = await seed(p);
  const before = (await get(s.accepted.transactionId))!;
  expect(before.nextRetryAt?.getTime()).toBe(epoch.getTime() + 20); expect(before.expiresAt?.getTime()).toBe(epoch.getTime() + 500);
  await processor(p).execute(s.bet); h.now = new Date(epoch.getTime() + 20);
  expect(await worker(p).resolve(s.candidate)).toEqual({ transactionId: s.candidate.id, action: 'processed' });
  expect(await snapshot(s.wallet.id)).toEqual({ ledger: '3', outbox: '7', inbox: '1', wager: '3', balance: '100.00', version: 3 });
  const replay = await processor(p).execute(s.refund);
  expect(replay.idempotentReplay).toBe(true); expect(replay.transactionId).toBe(s.candidate.id); expect(replay.status).toBe(WagerTransactionStatus.Processed);
  expect(replay.balance.amount).toBe('100.00'); expect((await get(s.candidate.id))?.expiresAt).toBeUndefined();
  expect((await snapshot(s.wallet.id)).outbox).toBe('7'); await reconcile(s.wallet.id, '100.00');
});
test('missing reference reschedules without changing snapshot, ledger, Inbox or Outbox', async () => {
  const h = ctx(); const s = await seed();
  await processor().execute(request(s.wallet, { kind: WagerTransactionKind.Win, money: { amount: '5.00', currency: 'BRL' } }));
  const before = await snapshot(s.wallet.id); h.now = new Date(epoch.getTime() + 1000);
  expect((await worker().resolve(s.candidate)).action).toBe('rescheduled');
  const persisted = (await get(s.candidate.id))!;
  expect(persisted.attempts).toBe(1); expect(persisted.nextRetryAt?.getTime()).toBe(epoch.getTime() + 3000);
  expect(persisted.expiresAt?.getTime()).toBe(epoch.getTime() + policy.ttlMs); expect(persisted.recordedBalance?.toString()).toBe('100.00');
  expect(await snapshot(s.wallet.id)).toEqual(before); await reconcile(s.wallet.id, '105.00');
});
test('TTL at exact expiry rejects with stable code and current terminal snapshot', async () => {
  const h = ctx(); const s = await seed(); await processor().execute(request(s.wallet));
  h.now = new Date(epoch.getTime() + policy.ttlMs);
  expect((await worker().runOnce()).map(r => r.action)).toEqual(['rejected']);
  const persisted = (await get(s.candidate.id))!;
  expect(persisted.failureCode).toBe(FailureCode.ReferenceNotFoundTimeout); expect(persisted.nextRetryAt).toBeUndefined();
  expect(persisted.recordedBalance?.toString()).toBe('90.00');
  const replay = await processor().execute(s.refund); expect(replay.balance.amount).toBe('90.00'); expect(replay.status).toBe(WagerTransactionStatus.Rejected);
  await reconcile(s.wallet.id, '90.00');
});
test.each([false, true])('last permitted attempt handles reference availability=%s without extra schedule', async available => {
  const h = ctx(); const p = { ...policy, maxAttempts: 2 }; const s = await seed(p); h.now = new Date(epoch.getTime() + 1000);
  expect((await worker(p).resolve(s.candidate)).action).toBe('rescheduled');
  if (available) { h.now = new Date(epoch.getTime() + 2000); await processor(p).execute(s.bet); }
  h.now = new Date(epoch.getTime() + 3000);
  expect((await worker(p).resolve(s.candidate)).action).toBe(available ? 'processed' : 'rejected');
  const persisted = (await get(s.candidate.id))!; expect(persisted.attempts).toBe(1); expect(persisted.nextRetryAt).toBeUndefined();
  expect(persisted.failureCode).toBe(available ? undefined : FailureCode.ReferenceNotFoundTimeout);
  await reconcile(s.wallet.id, '100.00');
});
test.each([3000, 2999])('backoff reaching or exceeding TTL=%s rejects instead of looping with domain error', async ttlMs => {
  const h = ctx(); const p = { ...policy, ttlMs }; const s = await seed(p); h.now = new Date(epoch.getTime() + 1000);
  expect((await worker(p).resolve(s.candidate)).action).toBe('rejected');
  expect((await get(s.candidate.id))?.failureCode).toBe(FailureCode.ReferenceNotFoundTimeout);
  expect((await worker(p).runOnce())).toEqual([]); await reconcile(s.wallet.id, '100.00');
});
test('terminal invalid reference preserves original domain rejection code', async () => {
  const h = ctx(); const wallet = await h.pg.wallet('0.00'); const bet = request(wallet);
  const accepted = await processor().execute(request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
  await processor().execute(bet); h.now = new Date(epoch.getTime() + 1000);
  expect((await worker().resolve({ walletId: wallet.id, id: accepted.transactionId })).action).toBe('rejected');
  expect((await get(accepted.transactionId))?.failureCode).toBe(FailureCode.ReferenceNotProcessed); await reconcile(wallet.id, '0.00');
});
test('temporarily pending chain waits, then three workers resolve BET -> REFUND -> ROLLBACK exactly once', async () => {
  const h = ctx(); const wallet = await h.pg.wallet(); const bet = request(wallet);
  const refund = request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
  const rollback = request(wallet, { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: refund.externalTransactionId });
  const rollAccepted = await processor().execute(rollback); const refAccepted = await processor().execute(refund);
  h.now = new Date(epoch.getTime() + 1000);
  expect((await worker().resolve({ id: rollAccepted.transactionId, walletId: wallet.id })).action).toBe('rescheduled');
  expect((await get(rollAccepted.transactionId))?.failureCode).toBeUndefined();
  await processor().execute(bet); h.now = new Date(epoch.getTime() + 3000);
  await runThree(); h.now = new Date(epoch.getTime() + 7000); await runThree();
  expect((await get(refAccepted.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
  expect((await get(rollAccepted.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
  expect(await snapshot(wallet.id)).toEqual({ ledger: '4', outbox: '10', inbox: '0', wager: '4', balance: '90.00', version: 4 });
  await reconcile(wallet.id, '90.00');
}, 60000);
test('three independent workers and an HTTP-shaped replay contend on the same pending refund safely', async () => {
  const h = ctx(); const s = await seed(); await processor().execute(s.bet); h.now = new Date(epoch.getTime() + 1000);
  const results = await runThree(policy, s.candidate, async () => { expect((await processor().execute(s.refund)).idempotentReplay).toBe(true); });
  expect(results.filter(r => r.action === 'processed')).toHaveLength(1); expect(results.filter(r => r.action === 'noop')).toHaveLength(2);
  expect(await snapshot(s.wallet.id)).toEqual({ ledger: '3', outbox: '7', inbox: '1', wager: '3', balance: '100.00', version: 3 });
  await reconcile(s.wallet.id, '100.00');
}, 60000);
test('crossed REFUND/ROLLBACK workers referencing the same BET cannot duplicate credit', async () => {
  const h = ctx(); const s = await seed();
  const rollback = await processor().execute(request(s.wallet, { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: s.bet.externalTransactionId }));
  await processor().execute(s.bet); h.now = new Date(epoch.getTime() + 1000); await runThree();
  const states = [(await get(s.candidate.id))!, (await get(rollback.transactionId))!];
  expect(states.filter(t => t.status === WagerTransactionStatus.Processed)).toHaveLength(1);
  expect(states.filter(t => t.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(1);
  expect((await snapshot(s.wallet.id)).ledger).toBe('3'); await reconcile(s.wallet.id, '100.00');
}, 60000);
test('rollback of a late WIN rejects with reversal-specific insufficient funds', async () => {
  const h = ctx(); const wallet = await h.pg.wallet('0.00'); const win = request(wallet, { kind: WagerTransactionKind.Win });
  const accepted = await processor().execute(request(wallet, { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: win.externalTransactionId }));
  await processor().execute(win); await processor().execute(request(wallet)); h.now = new Date(epoch.getTime() + 1000);
  expect((await worker().resolve({ id: accepted.transactionId, walletId: wallet.id })).action).toBe('rejected');
  expect((await get(accepted.transactionId))?.failureCode).toBe(FailureCode.InsufficientFundsReversal); await reconcile(wallet.id, '0.00');
});
test.each(['wallet', 'wager', 'ledger', 'outbox', 'beforeCommit'] as const)('failure at %s rolls back all resolution artifacts and retry succeeds once', async phase => {
  const h = ctx(); const s = await seed(); await processor().execute(s.bet); h.now = new Date(epoch.getTime() + 1000);
  const before = await snapshot(s.wallet.id); const previous = (await get(s.candidate.id))!;
  const failing = worker(policy, async point => { if (phase === point) throw new Error('injected resolution failure'); });
  await expect(failing.resolve(s.candidate)).rejects.toThrow('injected resolution failure');
  expect(await snapshot(s.wallet.id)).toEqual(before);
  const persisted = (await get(s.candidate.id))!; expect(persisted.status).toBe(WagerTransactionStatus.PendingReference);
  expect(persisted.attempts).toBe(previous.attempts); expect(persisted.nextRetryAt).toEqual(previous.nextRetryAt);
  expect((await worker().resolve(s.candidate)).action).toBe('processed');
  expect((await worker().resolve(s.candidate)).action).toBe('noop'); await reconcile(s.wallet.id, '100.00');
});
test('PostgreSQL 40P01 aborts then retries entire resolution without consuming financial/reference effects', async () => {
  const h = ctx(); const s = await seed(); await processor().execute(s.bet); h.now = new Date(epoch.getTime() + 1000);
  await h.pg.orm.em.fork().execute(`create sequence pending_retry_count;
    create function pending_transient() returns trigger as $$ begin
      if OLD.status='PENDING_REFERENCE' and NEW.status='PROCESSED' and nextval('pending_retry_count')=1 then
        raise exception 'injected deadlock state' using errcode='40P01'; end if; return NEW; end; $$ language plpgsql;
    create trigger pending_transient before update on wager_transactions for each row execute function pending_transient()`);
  expect((await worker().resolve(s.candidate)).action).toBe('processed');
  const [counter] = await h.pg.orm.em.fork().execute<{ n: string }[]>('select last_value::text as n from pending_retry_count');
  expect(counter?.n).toBe('2'); expect((await get(s.candidate.id))?.attempts).toBe(0);
  expect(await snapshot(s.wallet.id)).toEqual({ ledger: '3', outbox: '7', inbox: '1', wager: '3', balance: '100.00', version: 3 });
  await reconcile(s.wallet.id, '100.00');
});

test('available valid reference is processed even when worker scan was delayed beyond the waiting TTL', async () => {
  const h = ctx(); const s = await seed(); await processor().execute(s.bet);
  h.now = new Date(epoch.getTime() + policy.ttlMs + 1);
  expect((await worker().resolve(s.candidate)).action).toBe('processed');
  await reconcile(s.wallet.id, '100.00');
});

test('invalid cross-wallet reference resolves without waiting for the other wallet lock', async () => {
  const h = ctx(); const s = await seed(); const other = await h.pg.wallet();
  await processor().execute(request(other, { externalTransactionId: s.bet.externalTransactionId, idempotencyKey: `other-${randomUUID()}` }));
  h.now = new Date(epoch.getTime() + 1000);
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const held = h.pg.orm.em.fork().transactional(async em => {
    await em.execute('select id from wallets where id=? for update', [other.id]); entered(); await gate;
  });
  await ready;
  const resolution = worker().resolve(s.candidate); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Cross-wallet financial lock acquired')), 1500); });
    expect((await Promise.race([resolution, timeout])).action).toBe('rejected');
    expect((await get(s.candidate.id))?.failureCode).toBe(FailureCode.ReferenceContextMismatch);
  } finally { clearTimeout(timer); release(); await held; await resolution; }
  await reconcile(s.wallet.id, '100.00'); await reconcile(other.id, '90.00');
});

test('D02 WIN accepted as PENDING_REFERENCE then overflowing NUMERIC(18,2) terminalizes as FAILED without blocking healthy candidates', async () => {
  const h = ctx();
  const maxWallet = await h.pg.wallet('9999999999999990.00');
  const bet = request(maxWallet, { money: { amount: '10.00', currency: 'BRL' } });
  const winInput = request(maxWallet, { kind: WagerTransactionKind.Win, money: { amount: '20.00', currency: 'BRL' },
    referenceExternalTransactionId: bet.externalTransactionId });
  const acceptedWin = await processor().execute(winInput);
  expect(acceptedWin.status).toBe(WagerTransactionStatus.PendingReference);
  h.now = new Date(epoch.getTime() + 10);
  const healthy = await seed();
  await processor().execute(bet);
  await processor().execute(request(maxWallet, { kind: WagerTransactionKind.Win, money: { amount: '19.99', currency: 'BRL' } }));
  await processor().execute(healthy.bet);
  const beforeMax = await snapshot(maxWallet.id);
  expect(beforeMax.balance).toBe('9999999999999999.99');
  h.now = new Date(epoch.getTime() + 1010);
  const outcomes = await worker().runOnce();
  expect(outcomes).toEqual([
    { transactionId: acceptedWin.transactionId, action: 'failed' },
    { transactionId: healthy.candidate.id, action: 'processed' },
  ]);
  const persistedWin = (await get(acceptedWin.transactionId))!;
  expect(persistedWin.status).toBe(WagerTransactionStatus.Failed);
  expect(persistedWin.failureCode).toBe(FailureCode.InfrastructurePermanent);
  expect(persistedWin.recordedBalance?.toString()).toBe('9999999999999999.99');
  expect(persistedWin.nextRetryAt).toBeUndefined();
  expect(persistedWin.expiresAt).toBeUndefined();
  expect(await snapshot(maxWallet.id)).toEqual(beforeMax);
  const replay = await processor().execute(winInput);
  expect(replay).toEqual({
    transactionId: acceptedWin.transactionId,
    status: WagerTransactionStatus.Failed,
    failureCode: FailureCode.InfrastructurePermanent,
    balance: { amount: '9999999999999999.99', currency: 'BRL' },
    idempotentReplay: true,
  });
  expect(await worker().runOnce()).toEqual([]);
  expect(await worker().resolve({ id: acceptedWin.transactionId, walletId: maxWallet.id })).toEqual({
    transactionId: acceptedWin.transactionId,
    action: 'noop',
  });
  await reconcile(maxWallet.id, '9999999999999999.99');
  await reconcile(healthy.wallet.id, '100.00');
});

async function seedOverflow() {
  const wallet = await ctx().pg.wallet('9999999999999990.00');
  const bet = request(wallet, { money: { amount: '10.00', currency: 'BRL' } });
  const win = request(wallet, { kind: WagerTransactionKind.Win, money: { amount: '20.00', currency: 'BRL' },
    referenceExternalTransactionId: bet.externalTransactionId });
  const accepted = await processor().execute(win);
  expect(accepted.status).toBe(WagerTransactionStatus.PendingReference);
  await processor().execute(bet);
  await processor().execute(request(wallet, { kind: WagerTransactionKind.Win, money: { amount: '19.99', currency: 'BRL' } }));
  ctx().now = new Date(epoch.getTime() + 1000);
  return { wallet, win, candidate: { id: accepted.transactionId, walletId: wallet.id } };
}

/** Compare complete rows, including immutable ledger and unpublished event payloads. */
async function recoveryRows() {
  const rows: Record<string, unknown> = {};
  for (const [table, order] of [['wallets', 'id'], ['wallet_ledger_entries', 'id'], ['outbox_messages', 'id'],
    ['inbox_messages', 'consumer_name,message_id']] as const) {
    rows[table] = await ctx().pg.orm.em.fork().execute(`select * from ${table} order by ${order}`);
  }
  return rows;
}
async function wagerRow(id: string) {
  return ctx().pg.orm.em.fork().execute('select * from wager_transactions where id=?', [id]);
}

test('REV-D02-01 PostgreSQL failure after FAILED write rolls back the row and terminalization marker, then commits exactly once', async () => {
  const h = ctx(); const s = await seedOverflow();
  const before = await recoveryRows(); const wagerBefore = await wagerRow(s.candidate.id);
  // Fixture-only AFTER trigger: both the FAILED UPDATE and marker INSERT happen
  // in the real transaction before PostgreSQL raises the deliberate exception.
  await h.pg.orm.em.execute(`create table d02_failure_control(armed boolean not null);
    insert into d02_failure_control values (true);
    create table d02_failed_commits(transaction_id uuid primary key);
    create function d02_abort_failed() returns trigger as $$ begin
      insert into d02_failed_commits values (NEW.id);
      if (select armed from d02_failure_control) then
        raise exception 'D02 injected failure after FAILED write' using errcode='P0001';
      end if; return NEW; end; $$ language plpgsql;
    create trigger d02_abort_failed after update on wager_transactions for each row
      when (OLD.status='PENDING_REFERENCE' and NEW.status='FAILED') execute function d02_abort_failed()`);
  let failure: unknown;
  try { await worker().resolve(s.candidate); } catch (error) { failure = error; }
  expect(sqlError(failure).code).toBe('P0001');
  expect(await wagerRow(s.candidate.id)).toEqual(wagerBefore);
  expect(await recoveryRows()).toEqual(before);
  expect(await h.pg.orm.em.execute('select * from d02_failed_commits')).toEqual([]);
  await reconcile(s.wallet.id, '9999999999999999.99');
  await h.pg.orm.em.execute('update d02_failure_control set armed=false');
  expect(await worker().resolve(s.candidate)).toEqual({ transactionId: s.candidate.id, action: 'failed' });
  expect((await get(s.candidate.id))?.status).toBe(WagerTransactionStatus.Failed);
  expect(await worker().resolve(s.candidate)).toEqual({ transactionId: s.candidate.id, action: 'noop' });
  expect(await worker().runOnce()).toEqual([]);
  expect(await h.pg.orm.em.execute('select * from d02_failed_commits')).toEqual([{ transaction_id: s.candidate.id }]);
  expect(await recoveryRows()).toEqual(before);
  await reconcile(s.wallet.id, '9999999999999999.99');
});

test.each(['wager', 'beforeCommit'] as const)('REV-D02-01 failure at %s after FAILED persistence rolls back and retries without financial effects', async phase => {
  const s = await seedOverflow(); const before = await recoveryRows(); const wagerBefore = await wagerRow(s.candidate.id);
  const failing = worker(policy, async point => { if (point === phase) throw new Error(`D02-${phase}-rollback`); });
  await expect(failing.resolve(s.candidate)).rejects.toThrow(`D02-${phase}-rollback`);
  expect(await wagerRow(s.candidate.id)).toEqual(wagerBefore);
  expect(await recoveryRows()).toEqual(before);
  expect((await get(s.candidate.id))?.status).toBe(WagerTransactionStatus.PendingReference);
  expect(await worker().resolve(s.candidate)).toEqual({ transactionId: s.candidate.id, action: 'failed' });
  expect(await worker().resolve(s.candidate)).toEqual({ transactionId: s.candidate.id, action: 'noop' });
  expect(await recoveryRows()).toEqual(before);
  await reconcile(s.wallet.id, '9999999999999999.99');
});

test('REV-D02-02 independent worker processes preserve FAILED after restart and replay its historical balance after later wallet movement', async () => {
  const h = ctx(); const s = await seedOverflow(); const before = await recoveryRows();
  const first = await pendingWorkerChild(h.pg, h.now, policy, s.candidate);
  try {
    first.start(); expect(await first.done).toBe(0);
    expect(first.records.find(r => r.type === 'done')?.results).toEqual([{ transactionId: s.candidate.id, action: 'failed' }]);
  } finally { await first.close(); } // Process joined; its ORM/pool was closed by the child.
  const terminal = await wagerRow(s.candidate.id);
  expect((await get(s.candidate.id))?.failureCode).toBe(FailureCode.InfrastructurePermanent);
  expect(await recoveryRows()).toEqual(before);
  // Now the original credit WOULD fit, but restarting must not revive a terminal operation.
  await processor().execute(request(s.wallet, { money: { amount: '25.00', currency: 'BRL' } }));
  const afterMovement = await recoveryRows(); h.now = new Date(epoch.getTime() + policy.ttlMs + 1);
  const restarted = await pendingWorkerChild(h.pg, h.now, policy);
  try {
    expect(restarted.pid).not.toBe(first.pid); expect(restarted.backendPid).not.toBe(first.backendPid);
    restarted.start(); expect(await restarted.done).toBe(0);
    expect(restarted.records.find(r => r.type === 'done')?.results).toEqual([]);
  } finally { await restarted.close(); }
  const explicit = await pendingWorkerChild(h.pg, h.now, policy, s.candidate);
  try {
    explicit.start(); expect(await explicit.done).toBe(0);
    expect(explicit.records.find(r => r.type === 'done')?.results).toEqual([{ transactionId: s.candidate.id, action: 'noop' }]);
  } finally { await explicit.close(); }
  const replayProcess = await processClient(h.pg);
  try {
    expect(replayProcess.pid).not.toBe(first.pid);
    const replay = await replayProcess.run(s.win);
    expect(replay.ok).toBe(true);
    expect(replay.result).toEqual({ transactionId: s.candidate.id, status: WagerTransactionStatus.Failed,
      failureCode: FailureCode.InfrastructurePermanent, balance: { amount: '9999999999999999.99', currency: 'BRL' }, idempotentReplay: true });
  } finally { await replayProcess.close(); }
  expect(await wagerRow(s.candidate.id)).toEqual(terminal);
  expect(await recoveryRows()).toEqual(afterMovement);
  await reconcile(s.wallet.id, '9999999999999974.99');
}, 60000);
