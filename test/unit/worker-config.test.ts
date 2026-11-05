import { expect, test } from 'bun:test';
import { SystemClock } from '../../src/shared/application/clock';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';

test('worker configuration defaults preserve send margin and reference TTL', () => {
  const config = workerConfig({});
  expect(config).toEqual({ outboxLeaseMs: 10000, sqsSendTimeoutMs: 3000, outboxBaseRetryMs: 1000,
    outboxMaxRetryMs: 60000, pendingRefBaseDelayMs: 1000, pendingRefMaxAttempts: 10, pendingRefTtlMs: 86400000 });
  expect(Object.isFrozen(config)).toBe(true);
});
test('validated external scheduling configuration overrides defaults', () => {
  const config = workerConfig({ OUTBOX_LEASE_MS: '20000', SQS_SEND_TIMEOUT_MS: '5000', OUTBOX_BASE_RETRY_MS: '500',
    OUTBOX_MAX_RETRY_MS: '30000', PENDING_REF_BASE_DELAY_MS: '2000', PENDING_REF_MAX_ATTEMPTS: '4', PENDING_REF_TTL_MS: '60000' });
  expect(config.outboxLeaseMs).toBe(20000);
  expect(config.pendingRefMaxAttempts).toBe(4);
  expect(config.pendingRefTtlMs).toBe(60000);
});
test.each(['0', '-1', '1.5', 'NaN', 'Infinity', '', ' 1000', '1e3', '2147483648'])('rejects invalid scheduling value %s', value => {
  for (const key of ['OUTBOX_LEASE_MS', 'SQS_SEND_TIMEOUT_MS', 'OUTBOX_BASE_RETRY_MS', 'OUTBOX_MAX_RETRY_MS',
    'PENDING_REF_BASE_DELAY_MS', 'PENDING_REF_MAX_ATTEMPTS', 'PENDING_REF_TTL_MS']) {
    expect(() => workerConfig({ [key]: value })).toThrow();
  }
});
test('rejects unsafe relationships between lease, timeout, backoff and TTL', () => {
  expect(() => workerConfig({ OUTBOX_LEASE_MS: '3999' })).toThrow();
  expect(() => workerConfig({ OUTBOX_MAX_RETRY_MS: '999' })).toThrow();
  expect(() => workerConfig({ PENDING_REF_TTL_MS: '1000' })).toThrow();
});
test('system clock supplies finite independent Date instances', () => {
  const clock = new SystemClock();
  const a = clock.now(); const b = clock.now();
  expect(a).toBeInstanceOf(Date);
  expect(Number.isFinite(a.getTime())).toBe(true);
  expect(a).not.toBe(b);
});
