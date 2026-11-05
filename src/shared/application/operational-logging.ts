/** Operational records are projections, never financial payloads or Error objects. */
export const operationalEvents = [
  'wallet_created', 'wager_processed', 'wager_rejected', 'wager_pending_reference', 'wager_replayed', 'idempotency_conflict',
  'sqs_received', 'sqs_acked', 'sqs_retry_scheduled', 'sqs_ack_failed', 'sqs_dead_lettered',
  'outbox_sent', 'outbox_confirmed', 'outbox_confirmation_pending', 'outbox_retry_scheduled', 'outbox_lease_lost',
  'pending_reference_resolved', 'pending_reference_rescheduled', 'reconciliation_divergence', 'operational_error',
] as const;
export type OperationalEvent = typeof operationalEvents[number];
export type OperationalRecord = Readonly<Record<string, string | number | boolean>>;
export type OperationalSink = (record: OperationalRecord) => unknown;
export interface OperationalLoggingOptions { readonly operationalLog?: OperationalSink | undefined }

const events = new Set<string>(operationalEvents);
const components = new Set(['wallets', 'wagering', 'sqs-consumer', 'outbox-publisher', 'pending-reference-worker', 'http']);
const levels = new Set(['debug', 'info', 'warn', 'error']);
const statuses = new Set(['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED', 'processed', 'rejected', 'rescheduled']);
const actions = new Set(['acked', 'retry', 'dead-lettered', 'published', 'confirmation-pending', 'lease-lost', 'retry-scheduled', 'rescheduled', 'processed', 'rejected']);
const codes = new Set([
  'INSUFFICIENT_FUNDS_BET', 'INSUFFICIENT_FUNDS_REVERSAL', 'CURRENCY_MISMATCH', 'REFERENCE_NOT_FOUND_TIMEOUT',
  'REFERENCE_INVALID_KIND', 'REFERENCE_CONTEXT_MISMATCH', 'REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERSED', 'INFRASTRUCTURE_PERMANENT', 'IDEMPOTENCY_CONFLICT', 'INVALID_INPUT', 'INVALID_MONEY',
  'MONEY_OVERFLOW', 'WALLET_NOT_FOUND', 'POSTGRES_TRANSIENT', 'NETWORK_ERROR', 'TIMEOUT', 'SQS_TRANSIENT', 'UNKNOWN_ERROR',
  'ACK_FAILED', 'DLQ_SEND_FAILED', 'DLQ_ACK_FAILED', 'SQS_SEND_FAILED', 'SQS_SEND_TIMEOUT', 'RETRY_PERSIST_FAILED',
  'CONFIRMATION_PERSIST_FAILED', 'FENCED', 'INSUFFICIENT_LEASE_TIME', 'INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'HTTP_ERROR',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9_.:-]{1,128}$/;
// This is a bounded identifier grammar, not a general-purpose secret detector.
function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value) && !/^\d+\.\d{2}$/.test(value)
    && !/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(value)
    && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
    && !/(?:password|secret|token|receipt(?:handle)?):/i.test(value);
}
function own(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
/** Also used by adapters so an untrusted direct call cannot bypass the projection. */
export function projectOperationalRecord(input: unknown): OperationalRecord | undefined {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const event = own(input, 'event'); const component = own(input, 'component');
    if (typeof event !== 'string' || !events.has(event) || typeof component !== 'string' || !components.has(component)) return undefined;
    const level = own(input, 'level');
    const record: Record<string, string | number | boolean> = {
      timestamp: new Date().toISOString(), level: typeof level === 'string' && levels.has(level) ? level : 'info', component, event,
    };
    for (const key of ['transactionId', 'walletId', 'eventId']) {
      const value = own(input, key); if (typeof value === 'string' && uuid.test(value)) record[key] = value.toLowerCase();
    }
    for (const key of ['correlationId', 'messageId', 'sqsMessageId', 'providerId']) {
      const value = own(input, key); if (safeIdentifier(value)) record[key] = value;
    }
    for (const [key, allowed] of [['action', actions], ['code', codes], ['status', statuses]] as const) {
      const value = own(input, key); if (typeof value === 'string' && allowed.has(value)) record[key] = value;
    }
    const replay = own(input, 'idempotentReplay'); if (typeof replay === 'boolean') record['idempotentReplay'] = replay;
    const count = own(input, 'receiveCount'); if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 1) record['receiveCount'] = count;
    const duration = own(input, 'durationMs'); if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) record['durationMs'] = duration;
    return Object.freeze(record);
  } catch { return undefined; } // Proxies/getters cannot invalidate the observed operation.
}

// A weak entry per sink: no growing event queue, including for a sink that never settles.
const states = new WeakMap<object, { busy: boolean }>();
function isolatedCall(sink: object, call: () => unknown): void {
  let state = states.get(sink);
  if (!state) { state = { busy: false }; states.set(sink, state); }
  if (state.busy) return;
  state.busy = true;
  let pending = false;
  try {
    const result: unknown = call();
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      // Assimilation catches throwing then getters/methods and rejected thenables.
      // One pending result per sink; callers never await it or enqueue more work.
      pending = true;
      const release = () => { state.busy = false; };
      void Promise.resolve(result).then(release, release);
    }
  } catch { /* Best effort; never log a logging failure. */ }
  finally { if (!pending) state.busy = false; }
}
/** Preserve an existing observation format while isolating its optional callback. */
export function isolatedObserver<T>(sink?: (value: T) => unknown) {
  return (value: T): void => { if (typeof sink === 'function') isolatedCall(sink, () => sink(value)); };
}
export function operationalEmitter(sink?: OperationalSink) {
  return (input: unknown): void => {
    if (typeof sink !== 'function') return;
    isolatedCall(sink, () => { const record = projectOperationalRecord(input); if (record) return sink(record); });
  };
}
