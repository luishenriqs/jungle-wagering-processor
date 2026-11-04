import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalWagerPayload, wagerPayloadHash } from '../../src/modules/wagering/application/wager-payload';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';

const payload = { externalTransactionId: 'external', gameId: 'game', kind: WagerTransactionKind.Bet,
  money: { amount: '10.00', currency: 'BRL' }, playerId: 'player-test-01', providerId: 'provider', roundId: 'round', walletId: 'wallet' };
test('canonical fields and recursive key order have an exact SHA-256 representation', () => {
  const json = '{"externalTransactionId":"external","gameId":"game","kind":"BET","money":{"amount":"10.00","currency":"BRL"},"playerId":"player-test-01","providerId":"provider","referenceExternalTransactionId":null,"roundId":"round","walletId":"wallet"}';
  expect(canonicalWagerPayload(payload)).toBe(json);
  expect(wagerPayloadHash(payload)).toBe(createHash('sha256').update(json).digest('hex'));
  expect(wagerPayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(wagerPayloadHash(payload));
});
test('transport metadata and idempotency key are excluded; business changes are conflicts', () => {
  const envelope = { ...payload, idempotencyKey: 'different', messageId: 'message', occurredAt: new Date(), correlationId: 'correlation' };
  expect(wagerPayloadHash(envelope)).toBe(wagerPayloadHash(payload));
  for (const field of ['walletId', 'playerId', 'providerId', 'externalTransactionId', 'roundId', 'gameId'] as const) {
    expect(wagerPayloadHash({ ...payload, [field]: 'changed' })).not.toBe(wagerPayloadHash(payload));
  }
  expect(wagerPayloadHash({ ...payload, money: { amount: '11.00', currency: 'BRL' } })).not.toBe(wagerPayloadHash(payload));
  expect(() => wagerPayloadHash({ ...payload, money: { amount: '1e2', currency: 'BRL' } })).toThrow();
});
