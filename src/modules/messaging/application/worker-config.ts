import { pendingReferencePolicy } from '../../wagering/application/pending-reference-policy';
export interface WorkerConfig {
  readonly outboxLeaseMs: number;
  readonly sqsSendTimeoutMs: number;
  readonly outboxBaseRetryMs: number;
  readonly outboxMaxRetryMs: number;
  readonly pendingRefBaseDelayMs: number;
  readonly pendingRefMaxAttempts: number;
  readonly pendingRefTtlMs: number;
}
/** Fail on invalid configuration rather than silently using unsafe lease/TTL values. */
export function workerConfig(env: Readonly<Record<string, string | undefined>> = process.env): WorkerConfig {
  const positive = (key: string, fallback: number): number => {
    const text = env[key];
    if (text !== undefined && !/^[1-9][0-9]*$/.test(text)) throw new Error(`Invalid ${key}`);
    const value = text === undefined ? fallback : Number(text);
    if (!Number.isSafeInteger(value) || value > 2147483647) throw new Error(`Invalid ${key}`);
    return value;
  };
  const pending = pendingReferencePolicy(env);
  const config = {
    outboxLeaseMs: positive('OUTBOX_LEASE_MS', 10000),
    sqsSendTimeoutMs: positive('SQS_SEND_TIMEOUT_MS', 3000),
    outboxBaseRetryMs: positive('OUTBOX_BASE_RETRY_MS', 1000),
    outboxMaxRetryMs: positive('OUTBOX_MAX_RETRY_MS', 60000),
    pendingRefBaseDelayMs: pending.baseDelayMs,
    pendingRefMaxAttempts: pending.maxAttempts,
    pendingRefTtlMs: pending.ttlMs,
  };
  if (config.outboxLeaseMs < config.sqsSendTimeoutMs + 1000) throw new Error('OUTBOX_LEASE_MS requires at least 1000ms margin over SQS_SEND_TIMEOUT_MS');
  if (config.outboxMaxRetryMs < config.outboxBaseRetryMs) throw new Error('OUTBOX_MAX_RETRY_MS must cover OUTBOX_BASE_RETRY_MS');
  if (config.pendingRefTtlMs <= config.pendingRefBaseDelayMs) throw new Error('PENDING_REF_TTL_MS must exceed initial delay');
  return Object.freeze(config);
}
