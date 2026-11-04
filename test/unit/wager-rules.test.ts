import { expect, test } from 'bun:test';
import { LedgerDirection as D } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { FailureCode as F } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransaction as Tx, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wager-transaction';
import { evaluateWager } from '../../src/modules/wagering/domain/wager-rules';
import { createTransactionProps, m, processed } from '../fixtures';

const context = { walletId: 'wallet', playerId: 'player', balance: m('100.00'), referenceAlreadyReversed: false };
const dependent = (kind: K, overrides = {}) => Tx.create(createTransactionProps({ id: 'dependent-tx', externalTransactionId: 'dependent-ext', idempotencyKey: 'provider:dependent-ext', kind, referenceExternalTransactionId: 'external-tx', ...overrides }));

test.each([[K.Bet, D.Debit], [K.Win, D.Credit], [K.Loss, undefined]] as const)('%s direction and balance effect', (kind, direction) => {
  const tx = Tx.create(createTransactionProps({ kind }));
  expect(evaluateWager(tx, context)).toEqual({ status: 'PROCESSED', direction });
  expect(tx.ledgerDirectionFor()).toBe(direction);
});
test('BET insufficient and wallet context mismatch', () => {
  const tx = Tx.create(createTransactionProps());
  expect(evaluateWager(tx, { ...context, balance: m('1.00') })).toEqual({ status: 'REJECTED', code: F.InsufficientFundsBet });
  expect(evaluateWager(tx, { ...context, balance: m('1.00', 'USD') })).toEqual({ status: 'REJECTED', code: F.CurrencyMismatch });
  for (const change of [{ walletId: 'other' }, { playerId: 'other' }]) {
    expect(() => evaluateWager(tx, { ...context, ...change })).toThrow();
  }
});
test.each([K.Win, K.Refund, K.Rollback])('%s missing or nonterminal reference is pending', (kind) => {
  const tx = dependent(kind);
  expect(evaluateWager(tx, context).status).toBe('PENDING_REFERENCE');
  expect(evaluateWager(tx, { ...context, reference: Tx.create(createTransactionProps()) }).status).toBe('PENDING_REFERENCE');
});
test.each([K.Win, K.Refund, K.Rollback])('%s valid processed BET reference credits', (kind) => {
  const tx = dependent(kind);
  const reference = processed();
  expect(evaluateWager(tx, { ...context, reference })).toEqual({ status: 'PROCESSED', direction: D.Credit });
  expect(tx.ledgerDirectionFor(reference)).toBe(D.Credit);
});
test.each([K.Win, K.Refund])('ROLLBACK of %s debits and rejects insufficient reversal funds', (kind) => {
  const tx = dependent(K.Rollback);
  const reference = processed({ kind, ...(kind === K.Refund ? { referenceExternalTransactionId: 'bet' } : {}) });
  expect(evaluateWager(tx, { ...context, reference })).toEqual({ status: 'PROCESSED', direction: D.Debit });
  expect(evaluateWager(tx, { ...context, balance: m('0.00'), reference })).toEqual({ status: 'REJECTED', code: F.InsufficientFundsReversal });
});
test('refund and rollback require equal amount; WIN may differ from BET', () => {
  const reference = processed();
  for (const kind of [K.Refund, K.Rollback]) expect(evaluateWager(dependent(kind, { money: m('11.00') }), { ...context, reference })).toEqual({ status: 'REJECTED', code: F.ReferenceAmountMismatch });
  expect(evaluateWager(dependent(K.Win, { money: m('11.00') }), { ...context, reference }).status).toBe('PROCESSED');
});
test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)('reference mismatched %s', (field) => {
  const tx = dependent(K.Refund);
  expect(evaluateWager(tx, { ...context, reference: processed({ [field]: 'other' }) })).toEqual({ status: 'REJECTED', code: F.ReferenceContextMismatch });
});
test('reference currency, kind and terminal rejection/failure', () => {
  const tx = dependent(K.Refund);
  expect(evaluateWager(tx, { ...context, reference: Tx.rehydrate({ ...createTransactionProps({ money: m('10.00', 'USD') }), status: S.Processed }) })).toEqual({ status: 'REJECTED', code: F.CurrencyMismatch });
  for (const kind of [K.Win, K.Loss]) expect(evaluateWager(tx, { ...context, reference: processed({ kind }) })).toEqual({ status: 'REJECTED', code: F.ReferenceInvalidKind });
  for (const fail of [false, true]) {
    const ref = Tx.create(createTransactionProps());
    if (fail) ref.fail(F.InfrastructurePermanent); else ref.reject(F.InsufficientFundsBet, m('100.00'));
    expect(evaluateWager(tx, { ...context, reference: ref })).toEqual({ status: 'REJECTED', code: F.ReferenceNotProcessed });
  }
});
test.each([K.Win, K.Refund, K.Rollback])('%s rejects already reversed BET including crossed reversals', (kind) => {
  expect(evaluateWager(dependent(kind), { ...context, reference: processed(), referenceAlreadyReversed: true })).toEqual({ status: 'REJECTED', code: F.ReferenceAlreadyReversed });
});
test('ROLLBACK cannot reference LOSS or another ROLLBACK', () => {
  const tx = dependent(K.Rollback);
  for (const kind of [K.Loss, K.Rollback]) {
    const reference = processed({ kind, ...(kind === K.Rollback ? { referenceExternalTransactionId: 'bet' } : {}) });
    expect(evaluateWager(tx, { ...context, reference })).toEqual({ status: 'REJECTED', code: F.ReferenceInvalidKind });
    expect(() => tx.ledgerDirectionFor(reference)).toThrow();
  }
});
