import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { dateCopy } from '../../../shared/domain/validation';
import type { PendingReferenceSchedule } from '../domain/wager-transaction';

export interface PendingReferencePolicy { readonly baseDelayMs: number; readonly maxAttempts: number; readonly ttlMs: number }
export function validatePendingReferencePolicy(input: PendingReferencePolicy): PendingReferencePolicy {
  for (const key of ['baseDelayMs', 'maxAttempts', 'ttlMs'] as const) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > 2147483647) throw new InvalidDomainInputError(`Invalid pending reference ${key}`);
  }
  if (input.ttlMs <= input.baseDelayMs) throw new InvalidDomainInputError('Pending reference TTL must exceed initial delay');
  return Object.freeze({ ...input });
}
/** Single policy source for initial acceptance, standalone worker and environment configuration. */
export function pendingReferencePolicy(env: Readonly<Record<string, string | undefined>> = process.env): PendingReferencePolicy {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw !== undefined && !/^[1-9][0-9]*$/.test(raw)) throw new InvalidDomainInputError(`Invalid ${name}`);
    return raw === undefined ? fallback : Number(raw);
  };
  return validatePendingReferencePolicy({ baseDelayMs: read('PENDING_REF_BASE_DELAY_MS', 1000),
    maxAttempts: read('PENDING_REF_MAX_ATTEMPTS', 10), ttlMs: read('PENDING_REF_TTL_MS', 86400000) });
}
export function initialReferenceSchedule(now: Date, policy: PendingReferencePolicy): PendingReferenceSchedule {
  const at = dateCopy(now).getTime();
  return { nextRetryAt: dateCopy(new Date(at + policy.baseDelayMs)), expiresAt: dateCopy(new Date(at + policy.ttlMs)) };
}
/** attempts counts completed reschedules. Check number attempts+1 is the current due resolution attempt. */
export function nextReferenceRetry(state: { readonly attempts: number; readonly nextRetryAt: Date; readonly expiresAt: Date },
  now: Date, policy: PendingReferencePolicy): Date | undefined {
  const at = dateCopy(now).getTime(); const deadline = dateCopy(state.expiresAt).getTime();
  if (!Number.isSafeInteger(state.attempts) || state.attempts < 0) throw new InvalidDomainInputError('Invalid reference attempt counter');
  if (at >= deadline || state.attempts + 1 >= policy.maxAttempts) return undefined;
  if (at < dateCopy(state.nextRetryAt).getTime()) throw new InvalidDomainInputError('Reference is not due');
  const delay = policy.baseDelayMs * 2 ** Math.min(state.attempts + 1, 53);
  // Compare before constructing a Date: huge backoff cannot overflow or reach/exceed the deadline.
  if (delay >= deadline - at) return undefined;
  return dateCopy(new Date(at + delay));
}
