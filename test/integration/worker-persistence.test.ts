import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHarness, request, type Harness } from '../support/postgres';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';

let h: Harness;
beforeEach(async () => { h = await createHarness(); }, 30000);
afterEach(async () => { if (h) await h.close(); });
const at = new Date('2035-01-01T00:00:00.000Z');
const time = (ms: number) => new Date(at.getTime() + ms);
const claim = (owner: string, token = randomUUID(), now = at) => h.uow.run(s => s.claimNextOutbox(owner, token, now, new Date(now.getTime() + 10000)));

test('Outbox lease uses explicit virtual time; SKIP LOCKED does not wait for a locked candidate', async () => {
  const wallet = await h.wallet(); // Two opening events, both committed before any claim.
  let ready!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { ready = r; });
  const gate = new Promise<void>(r => { release = r; });
  const held = h.uow.run(async s => {
    const first = await s.claimNextOutbox('first', randomUUID(), at, time(10000));
    ready(); await gate; return first;
  });
  try {
    await started;
    const second = await claim('second');
    expect(second).toBeDefined();
    const third = await claim('third');
    expect(third).toBeUndefined();
    release();
    const first = await held;
    expect(first?.message.id).not.toBe(second?.message.id);
    expect(first?.message.aggregateId).toBe(wallet.id);
    expect(await claim('early', randomUUID(), time(9999))).toBeUndefined();
  } finally { release(); await held; }
});

test('expired lease is reclaimed; old token cannot complete or reschedule the new owner', async () => {
  await h.wallet();
  const old = (await claim('old'))!;
  const other = (await claim('other'))!;
  expect(old).toBeDefined(); expect(other).toBeDefined();
  const fresh = (await claim('fresh', randomUUID(), time(10000)))!;
  expect([old.message.id, other.message.id]).toContain(fresh.message.id);
  const stale = fresh.message.id === old.message.id ? old : other;
  expect(await h.uow.run(s => s.completeOutbox(stale.message.id, stale.workerId, stale.leaseToken, time(10001)))).toBe(false);
  stale.message.scheduleRetry(time(10001));
  expect(await h.uow.run(s => s.failOutbox(stale.message, stale.workerId, stale.leaseToken, time(10001), 'NETWORK_ERROR'))).toBe(false);
  expect(await h.uow.run(s => s.completeOutbox(fresh.message.id, fresh.workerId, fresh.leaseToken, time(10002)))).toBe(true);
  expect(await h.uow.run(s => s.completeOutbox(fresh.message.id, fresh.workerId, fresh.leaseToken, time(10003)))).toBe(false);
});

test('retry retains event identity, increments attempts and respects nextAttemptAt', async () => {
  await h.wallet();
  const first = (await claim('retry'))!;
  const other = (await claim('other'))!;
  expect(await h.uow.run(s => s.completeOutbox(other.message.id, other.workerId, other.leaseToken, time(1)))).toBe(true);
  first.message.scheduleRetry(time(100));
  expect(await h.uow.run(s => s.failOutbox(first.message, first.workerId, first.leaseToken, time(100), 'SQS_TIMEOUT'))).toBe(true);
  expect(await claim('early', randomUUID(), time(1099))).toBeUndefined();
  const next = (await claim('retry2', randomUUID(), time(1100)))!;
  expect(next.message.id).toBe(first.message.id);
  expect(next.message.attempts).toBe(1);
  expect(next.message.payload).toEqual(first.message.payload);
  expect(next.leaseToken).not.toBe(first.leaseToken);
});

test('expired claim cannot complete even before a new worker takes ownership', async () => {
  await h.wallet(); const c = (await claim('expired'))!;
  expect(await h.uow.run(s => s.completeOutbox(c.message.id, c.workerId, c.leaseToken, time(10000)))).toBe(false);
});

test('pending discovery is nonlocking and follows virtual time; conditional updates preserve terminal state', async () => {
  const wallet = await h.wallet();
  const process = new ProcessWagerTransactionUseCase(h.uow, { now: () => at });
  const result = await process.execute(request(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: randomUUID() }));
  expect(await h.uow.run(s => s.findDuePendingWagers(time(999), 10))).toHaveLength(0);
  const due = await h.uow.run(s => s.findDuePendingWagers(time(1000), 10));
  expect(due.map(t => t.id)).toEqual([result.transactionId]);
  await h.uow.run(async s => {
    const lockedWallet = (await s.getWallet(wallet.id, true))!;
    const wager = (await s.getWager(result.transactionId, true))!;
    wager.reschedulePendingReference(time(3000));
    expect(await s.updatePendingWager(wager)).toBe(true);
    wager.reject(FailureCode.ReferenceNotFoundTimeout, lockedWallet.balance);
    expect(await s.updatePendingWager(wager)).toBe(true);
    expect(await s.updatePendingWager(wager)).toBe(false);
  });
  expect(await h.uow.run(s => s.findDuePendingWagers(time(86400000), 10))).toHaveLength(0);
  const persisted = await h.uow.run(s => s.getWager(result.transactionId));
  expect(persisted?.status).toBe(WagerTransactionStatus.Rejected);
  expect(persisted?.attempts).toBe(1);
  expect(persisted?.nextRetryAt).toBeUndefined();
  expect(persisted?.failureCode).toBe(FailureCode.ReferenceNotFoundTimeout);
  expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
});
