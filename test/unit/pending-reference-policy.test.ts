import { expect, test } from 'bun:test';
import { initialReferenceSchedule, nextReferenceRetry, pendingReferencePolicy, validatePendingReferencePolicy } from '../../src/modules/wagering/application/pending-reference-policy';
import { workerConfig } from '../../src/modules/messaging/application/worker-config';
const at = new Date('2035-01-01T00:00:00Z');
const policy = pendingReferencePolicy({});
const schedule = initialReferenceSchedule(at, policy);
const due = schedule.nextRetryAt;
test('shared policy keeps approved defaults and immutable configuration', () => {
  expect(policy).toEqual({ baseDelayMs: 1000, maxAttempts: 10, ttlMs: 86400000 }); expect(Object.isFrozen(policy)).toBe(true);
  expect(schedule.nextRetryAt.getTime() - at.getTime()).toBe(1000); expect(schedule.expiresAt.getTime() - at.getTime()).toBe(86400000);
});
test('environment overrides are shared by acceptance and worker configuration', () => {
  const env = { PENDING_REF_BASE_DELAY_MS: '20', PENDING_REF_MAX_ATTEMPTS: '3', PENDING_REF_TTL_MS: '500' };
  const p = pendingReferencePolicy(env); const cfg = workerConfig(env);
  expect(p).toEqual({ baseDelayMs: 20, maxAttempts: 3, ttlMs: 500 });
  expect(cfg.pendingRefBaseDelayMs).toBe(p.baseDelayMs); expect(cfg.pendingRefMaxAttempts).toBe(p.maxAttempts); expect(cfg.pendingRefTtlMs).toBe(p.ttlMs);
});
test('reschedule uses exponential backoff measured from the current due attempt', () => {
  const first = nextReferenceRetry({ ...schedule, attempts: 0 }, due, policy)!;
  expect(first.getTime() - due.getTime()).toBe(2000);
  const second = nextReferenceRetry({ ...schedule, nextRetryAt: first, attempts: 1 }, first, policy)!;
  expect(second.getTime() - first.getTime()).toBe(4000);
});
test('maximum attempts allows the last due check but no further schedule', () => {
  expect(nextReferenceRetry({ ...schedule, attempts: 9 }, due, policy)).toBeUndefined();
  expect(nextReferenceRetry({ ...schedule, attempts: 0 }, due, { ...policy, maxAttempts: 1 })).toBeUndefined();
});
test('deadline equal to next backoff rejects before constructing or passing an invalid Date', () => {
  expect(nextReferenceRetry({ ...schedule, expiresAt: new Date(due.getTime() + 2000), attempts: 0 }, due, policy)).toBeUndefined();
  expect(nextReferenceRetry({ ...schedule, expiresAt: new Date(due.getTime() + 1999), attempts: 0 }, due, policy)).toBeUndefined();
  expect(nextReferenceRetry({ ...schedule, attempts: 0 }, schedule.expiresAt, policy)).toBeUndefined();
});
test('large exponent is rejected safely by TTL without date overflow', () => {
  expect(nextReferenceRetry({ ...schedule, attempts: 1000 }, due, { ...policy, maxAttempts: 1002 })).toBeUndefined();
});
test('not-due state and invalid attempt counters are rejected', () => {
  expect(() => nextReferenceRetry({ ...schedule, attempts: 0 }, at, policy)).toThrow();
  expect(() => nextReferenceRetry({ ...schedule, attempts: -1 }, due, policy)).toThrow();
});
test.each(['0', '-1', '', 'NaN', '1.5', '1e3', '2147483648'])('reject malformed pending policy %s', value => {
  for (const key of ['PENDING_REF_BASE_DELAY_MS', 'PENDING_REF_MAX_ATTEMPTS', 'PENDING_REF_TTL_MS']) expect(() => pendingReferencePolicy({ [key]: value })).toThrow();
});
test('TTL must exceed initial delay; explicit override is defensively copied', () => {
  expect(() => pendingReferencePolicy({ PENDING_REF_TTL_MS: '1000' })).toThrow();
  const input = { baseDelayMs: 10, maxAttempts: 2, ttlMs: 30 }; const p = validatePendingReferencePolicy(input); input.ttlMs = 40;
  expect(p.ttlMs).toBe(30);
});
