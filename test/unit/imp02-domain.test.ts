import { expect, test } from 'bun:test';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { createTransactionProps, at, m } from '../fixtures';

test.each([K.Bet, K.Loss])('%s rejects unexpected external reference', kind => {
  expect(() => WagerTransaction.create(createTransactionProps({ kind, referenceExternalTransactionId: 'other' }))).toThrow();
});
test.each([K.Bet, K.Loss, K.Win])('%s without external reference cannot process with an internal reference', kind => {
  const tx = WagerTransaction.create(createTransactionProps({ kind }));
  expect(() => tx.markProcessed('unexpected', at, m('100.00'))).toThrow();
  expect(tx.status).toBe(S.Pending);
  expect(tx.referenceTransactionId).toBeUndefined();
});
test('pending reference rescheduling increments attempts without replacing acceptance snapshot/deadline', () => {
  const tx = WagerTransaction.create(createTransactionProps({ kind: K.Refund, referenceExternalTransactionId: 'bet' }));
  const expiresAt = new Date(at.getTime() + 10000);
  tx.markPendingReference(m('100.00'), { nextRetryAt: at, expiresAt });
  const next = new Date(at.getTime() + 1000);
  tx.reschedulePendingReference(next);
  next.setFullYear(2000);
  expect(tx.attempts).toBe(1);
  expect(tx.nextRetryAt?.getTime()).toBe(at.getTime() + 1000);
  expect(tx.expiresAt?.getTime()).toBe(expiresAt.getTime());
  expect(tx.recordedBalance?.toString()).toBe('100.00');
  for (const invalid of [at, expiresAt, new Date('invalid')]) expect(() => tx.reschedulePendingReference(invalid)).toThrow();
  expect(tx.attempts).toBe(1);
  tx.reject(FailureCode.ReferenceNotFoundTimeout, m('100.00'));
  expect(() => tx.reschedulePendingReference(new Date(at.getTime() + 2000))).toThrow();
});
test.each([S.Pending, S.Processed, S.Rejected, S.Failed])('reschedule rejects state %s', status => {
  const tx = WagerTransaction.rehydrate({ ...createTransactionProps(), status });
  expect(() => tx.reschedulePendingReference(at)).toThrow();
  expect(tx.status).toBe(status);
});
