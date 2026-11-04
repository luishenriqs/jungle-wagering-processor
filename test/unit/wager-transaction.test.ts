import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wager-transaction';
import { createTransactionProps, m, at } from '../fixtures';

test('new external transactions start pending and identity is immutable', () => {
  const props = createTransactionProps();
  const tx = WagerTransaction.create(props);
  expect(tx.status).toBe(S.Pending);
  expect(tx.isTerminal()).toBe(false);
  expect(tx.matchesPayload(props.payloadHash)).toBe(true);
  expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  expect(Reflect.set(tx, 'idempotencyKey', 'changed')).toBe(false);
  expect(() => tx.assertReplay({ ...props, payloadHash: 'b'.repeat(64) })).toThrow();
  expect(() => tx.assertReplay({ ...props, idempotencyKey: 'other' })).toThrow();
  expect(() => tx.assertReplay({ ...props, externalTransactionId: 'other' })).toThrow();
  expect(() => tx.assertReplay(props)).not.toThrow();
});
test.each([K.Refund, K.Rollback])('%s requires an external reference', (kind) => {
  expect(() => WagerTransaction.create(createTransactionProps({ kind }))).toThrow();
  expect(WagerTransaction.create(createTransactionProps({ kind, referenceExternalTransactionId: 'bet' })).requiresReference()).toBe(true);
});
test.each([K.Bet, K.Win, K.Refund, K.Rollback])('%s requires positive amount', (kind) => {
  expect(() => WagerTransaction.create(createTransactionProps({ kind, money: m('0.00'), referenceExternalTransactionId: 'ref' }))).toThrow();
});
test('LOSS allows zero and positive, has no ledger direction', () => {
  for (const amount of ['0.00', '10.00']) {
    const tx = WagerTransaction.create(createTransactionProps({ kind: K.Loss, money: m(amount) }));
    expect(tx.affectsBalance()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBeUndefined();
  }
  expect(() => WagerTransaction.create(createTransactionProps({ kind: K.Loss, money: m('1.00').negate() }))).toThrow();
});
test('external OPENING and reserved SYSTEM provider are rejected', () => {
  expect(() => WagerTransaction.create(createTransactionProps({ kind: K.Opening }))).toThrow();
  expect(() => WagerTransaction.create(createTransactionProps({ providerId: 'SYSTEM' }))).toThrow();
});
test('invalid identity, hash, kind and self reference are rejected', () => {
  for (const change of [{ id: '' }, { providerId: '' }, { payloadHash: 'bad' },
    { kind: 'UNKNOWN' as K }, { kind: K.Win, referenceExternalTransactionId: 'external-tx' },
    { referenceExternalTransactionId: '' }]) {
    expect(() => WagerTransaction.create(createTransactionProps(change))).toThrow();
  }
});
test.each([S.Processed, S.Rejected, S.Failed])('terminal %s rejects every transition', (status) => {
  const tx = WagerTransaction.rehydrate({ ...createTransactionProps(), status, recordedBalance: m('7.00'), failureCode: FailureCode.InfrastructurePermanent, processedAt: at });
  for (const attempt of [
    () => tx.markProcessed(undefined, at, m('7.00')),
    () => tx.markPendingReference(m('7.00'), { nextRetryAt: at, expiresAt: new Date(at.getTime() + 1000) }),
    () => tx.reject(FailureCode.InsufficientFundsBet, m('7.00')),
    () => tx.fail(FailureCode.InfrastructurePermanent),
  ]) expect(attempt).toThrow();
  expect(tx.status).toBe(status);
});
test.each([false, true])('valid processing, rejection and failure from pendingReference=%s', (pendingReference) => {
  for (const target of [S.Processed, S.Rejected, S.Failed]) {
    const tx = WagerTransaction.create(createTransactionProps({ kind: K.Win, referenceExternalTransactionId: 'bet' }));
    if (pendingReference) tx.markPendingReference(m('10.00'), { nextRetryAt: at, expiresAt: new Date(at.getTime() + 1000) });
    if (target === S.Processed) tx.markProcessed('ref', at, m('20.00'));
    if (target === S.Rejected) tx.reject(FailureCode.ReferenceInvalidKind, m('10.00'));
    if (target === S.Failed) tx.fail(FailureCode.InfrastructurePermanent);
    expect(tx.status).toBe(target);
    expect(tx.isTerminal()).toBe(true);
  }
});
test('invalid transitions do not partially mutate a transaction', () => {
  const tx = WagerTransaction.create(createTransactionProps({ kind: K.Refund, referenceExternalTransactionId: 'bet' }));
  expect(() => tx.markProcessed(undefined, at, m('10.00'))).toThrow();
  expect(() => tx.markProcessed('ref', new Date('invalid'), m('10.00'))).toThrow();
  expect(() => tx.reject(FailureCode.ReferenceInvalidKind, Money.zero('USD'))).toThrow();
  expect(tx.status).toBe(S.Pending);
  expect(tx.referenceTransactionId).toBeUndefined();
  expect(tx.failureCode).toBeUndefined();
  const bet = WagerTransaction.create(createTransactionProps());
  expect(() => bet.markPendingReference(m('10.00'), { nextRetryAt: at, expiresAt: at })).toThrow();
});
test('pending reference only entered once and preserves acceptance snapshot', () => {
  const tx = WagerTransaction.create(createTransactionProps({ kind: K.Win, referenceExternalTransactionId: 'bet' }));
  const schedule = { nextRetryAt: at, expiresAt: new Date(at.getTime() + 1000) };
  tx.markPendingReference(m('12.00'), schedule);
  expect(() => tx.markPendingReference(m('13.00'), schedule)).toThrow();
  expect(tx.recordedBalance?.toString()).toBe('12.00');
  expect(tx.attempts).toBe(0);
  tx.markProcessed('ref', at, m('15.00'));
  expect(tx.recordedBalance?.toString()).toBe('15.00');
});
test('rehydration preserves snapshots, status, identity and dates without transitions', () => {
  const date = new Date(at);
  const tx = WagerTransaction.rehydrate({ ...createTransactionProps({ createdAt: date }), status: S.Processed, recordedBalance: m('5.00'), processedAt: date });
  date.setFullYear(2000);
  tx.createdAt.setFullYear(2001);
  tx.processedAt?.setFullYear(2002);
  expect(tx.processedAt?.toISOString()).toBe(at.toISOString());
  expect(tx.createdAt.toISOString()).toBe(at.toISOString());
  expect(tx.recordedBalance?.toString()).toBe('5.00');
  expect(tx.status).toBe(S.Processed);
});
