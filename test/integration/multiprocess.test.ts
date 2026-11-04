import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHarness, request, type Harness } from '../support/postgres';
import { processClient } from '../support/process-client';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode as F } from '../../src/modules/wagering/domain/failure-code';

let h: Harness;
beforeAll(async () => { h = await createHarness(); }, 30000);
afterAll(async () => { if (h) await h.close(); });
test('three real Bun processes: duplicate hot wallet, references and concurrent reversals', async () => {
  const workers = await Promise.all([1, 2, 3].map(() => processClient(h)));
  try {
    expect(new Set(workers.map(w => w.pid)).size).toBe(3);
    expect(new Set(workers.map(w => w.backendPid)).size).toBe(3);
    console.log(JSON.stringify({ scenario: 'multiprocess', pids: workers.map(w => w.pid), pgBackendPids: workers.map(w => w.backendPid) }));
    const w = await h.wallet(); const bet = request(w, { money: { amount: '80.00', currency: 'BRL' } });
    const duplicateResults = await Promise.all(Array.from({ length: 50 }, (_, i) => workers[i % 3]!.run(bet)));
    expect(duplicateResults.every(r => r.ok)).toBe(true);
    expect(duplicateResults.filter(r => r.result?.idempotentReplay === false)).toHaveLength(1);
    expect(duplicateResults.filter(r => r.result?.idempotentReplay === true)).toHaveLength(49);
    expect(duplicateResults.every(r => r.result?.balance.amount === '20.00')).toBe(true);
    const second = await h.wallet();
    const competing = await Promise.all(workers.map(client => client.run(request(second, { money: { amount: '80.00', currency: 'BRL' } }))));
    expect(competing.filter(r => r.result?.status === S.Processed)).toHaveLength(1);
    expect(competing.filter(r => r.result?.failureCode === F.InsufficientFundsBet)).toHaveLength(2);
    expect((await h.get.execute(second.id)).version).toBe(2);
    const reversals = await Promise.all(workers.map((client, index) => client.run(request(w, { kind: index === 0 ? K.Refund : K.Rollback,
      referenceExternalTransactionId: bet.externalTransactionId, money: bet.money }))));
    expect(reversals.filter(r => r.result?.status === S.Processed)).toHaveLength(1);
    expect(reversals.filter(r => r.result?.failureCode === F.ReferenceAlreadyReversed)).toHaveLength(2);
    expect((await h.reconcile.execute(w.id)).consistent).toBe(true);
    expect((await h.reconcile.execute(second.id)).consistent).toBe(true);
    const credits = await Promise.all(workers.map(client => client.run(request(w, { kind: K.Win, money: { amount: '10.00', currency: 'BRL' } }))));
    expect(credits.every(r => r.result?.status === S.Processed)).toBe(true);
    expect((await h.reconcile.execute(w.id)).consistent).toBe(true);
    const distinct = await Promise.all(workers.map(() => h.wallet()));
    const separate = await Promise.all(workers.map((client, index) => client.run(request(distinct[index]!))));
    expect(separate.every(r => r.result?.balance.amount === '90.00')).toBe(true);
    for (const wallet of distinct) expect((await h.reconcile.execute(wallet.id)).consistent).toBe(true);
    const referencedWallet = await h.wallet(); const original = request(referencedWallet);
    await h.process.execute(original);
    const wins = await Promise.all(workers.map(client => client.run(request(referencedWallet, { kind: K.Win, referenceExternalTransactionId: original.externalTransactionId }))));
    expect(wins.every(r => r.result?.status === S.Processed)).toBe(true);
    expect((await h.reconcile.execute(referencedWallet.id)).consistent).toBe(true);
  } finally { await Promise.all(workers.map(worker => worker.close())); }
}, 90000);
test('an unrelated wallet completes while another wallet is locked in PostgreSQL', async () => {
  const [a, b] = await Promise.all([h.wallet(), h.wallet()]);
  const worker = await processClient(h);
  let unlock!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const holding = h.uow.run(async store => { await store.getWallet(a.id, true); locked(); await gate; });
  try {
    await acquired;
    const result = await worker.run(request(b));
    expect(result.result?.status).toBe(S.Processed);
  } finally { unlock(); await holding; await worker.close(); }
  expect((await h.reconcile.execute(a.id)).consistent).toBe(true);
  expect((await h.reconcile.execute(b.id)).consistent).toBe(true);
}, 30000);
test('process exits before commit roll back; exit after commit replays safely from another process', async () => {
  const w = await h.wallet(); const input = request(w, { inbox: { consumerName: 'restart', messageId: crypto.randomUUID(), receivedAt: new Date() } });
  const before = await processClient(h);
  try { await expect(before.run(input, 'exit-before-commit')).rejects.toThrow('Worker exited 17'); }
  finally { await before.close(); }
  expect((await h.get.execute(w.id)).balance.toString()).toBe('100.00');
  const committed = await processClient(h);
  try { await expect(committed.run(input, 'exit-after-commit')).rejects.toThrow('Worker exited 18'); }
  finally { await committed.close(); }
  const replay = await processClient(h);
  try {
    const result = await replay.run(input);
    expect(result.result?.idempotentReplay).toBe(true);
    expect(result.result?.balance.amount).toBe('90.00');
    expect((await h.get.execute(w.id)).version).toBe(2);
    expect((await h.reconcile.execute(w.id)).checkedEntries).toBe(2);
  } finally { await replay.close(); }
}, 90000);
