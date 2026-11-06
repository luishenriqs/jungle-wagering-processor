export const OPERATIONAL_METRICS = 'OPERATIONAL_METRICS' as const;

export type WagerMetricStatus = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';

export type RetryMetricTarget =
  | 'wagerUow'
  | 'walletUow'
  | 'pendingReference'
  | 'sqsConsumer'
  | 'outboxPublisher';

export type ConcurrencyMetricCode = '40P01' | '40001' | '55P03' | '57014' | '23505';

export type OperationalMetricObservation =
  | { readonly type: 'wager-status'; readonly status: WagerMetricStatus }
  | { readonly type: 'duplicate'; readonly kind: 'replay' | 'conflict' }
  | { readonly type: 'retry-scheduled'; readonly target: RetryMetricTarget }
  | { readonly type: 'concurrency-conflict'; readonly code: ConcurrencyMetricCode }
  | { readonly type: 'dlq-transfer-confirmed' }
  | { readonly type: 'outbox-publication-confirmed'; readonly lagMs: number }
  | { readonly type: 'processing-duration'; readonly durationMs: number }
  | { readonly type: 'pending-reference-resolution'; readonly action: 'processed' | 'rejected' | 'rescheduled' }
  | { readonly type: 'reconciliation-divergence' };

export type OperationalMetricsObserver = (observation: OperationalMetricObservation) => unknown;

export interface OperationalMetricsPort {
  observe(observation: OperationalMetricObservation): unknown;
}

export type OperationalMetricsInput = OperationalMetricsObserver | OperationalMetricsPort;

export interface OperationalMetricsOptions {
  readonly operationalMetrics?: OperationalMetricsInput | undefined;
}

export interface OperationalMetricsBuckets {
  readonly le5Ms: number;
  readonly le10Ms: number;
  readonly le25Ms: number;
  readonly le50Ms: number;
  readonly le100Ms: number;
  readonly le250Ms: number;
  readonly le500Ms: number;
  readonly le1000Ms: number;
  readonly gt1000Ms: number;
}

export interface OperationalMetricsTimeAggregate {
  readonly count: number;
  readonly totalMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly lastMs: number;
  readonly buckets: OperationalMetricsBuckets;
}

export interface OperationalMetricsConcurrencyAggregate {
  readonly total: number;
  readonly byCode: Readonly<Record<ConcurrencyMetricCode, number>>;
}

export interface OperationalMetricsSnapshot {
  readonly scope: 'process';
  readonly transactionsByStatus: Readonly<Record<WagerMetricStatus, number>>;
  readonly duplicates: {
    readonly replays: number;
    readonly conflicts: number;
  };
  readonly retries: Readonly<Record<RetryMetricTarget, number>>;
  readonly dlq: {
    readonly confirmedTransfers: number;
  };
  readonly concurrencyConflicts: {
    readonly total: number;
    readonly byCode: Readonly<Record<ConcurrencyMetricCode, number>>;
  };
  readonly outboxLagMs: OperationalMetricsTimeAggregate;
  readonly processingDurationMs: OperationalMetricsTimeAggregate;
  readonly reconciliation: {
    readonly divergences: number;
  };
  readonly pendingReference: {
    readonly processed: number;
    readonly rejected: number;
    readonly rescheduled: number;
  };
}

export interface OperationalMetricsCollector extends OperationalMetricsPort {
  snapshot(): OperationalMetricsSnapshot;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] extends object ? Mutable<T[Key]> : T[Key] };
type MutableSnapshot = Mutable<OperationalMetricsSnapshot>;

const WAGER_STATUSES: readonly WagerMetricStatus[] = ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'];
const RETRY_TARGETS: readonly RetryMetricTarget[] = ['wagerUow', 'walletUow', 'pendingReference', 'sqsConsumer', 'outboxPublisher'];
const CONCURRENCY_CODES: readonly ConcurrencyMetricCode[] = ['40P01', '40001', '55P03', '57014', '23505'];
const PENDING_ACTIONS = ['processed', 'rejected', 'rescheduled'] as const;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function zeroBuckets(): Mutable<OperationalMetricsBuckets> {
  return { le5Ms: 0, le10Ms: 0, le25Ms: 0, le50Ms: 0, le100Ms: 0, le250Ms: 0, le500Ms: 0, le1000Ms: 0, gt1000Ms: 0 };
}

function zeroTimeAggregate(): Mutable<OperationalMetricsTimeAggregate> {
  return { count: 0, totalMs: 0, minMs: 0, maxMs: 0, lastMs: 0, buckets: zeroBuckets() };
}

function initialSnapshot(): MutableSnapshot {
  return {
    scope: 'process',
    transactionsByStatus: { PROCESSED: 0, REJECTED: 0, PENDING_REFERENCE: 0, FAILED: 0 },
    duplicates: { replays: 0, conflicts: 0 },
    retries: { wagerUow: 0, walletUow: 0, pendingReference: 0, sqsConsumer: 0, outboxPublisher: 0 },
    dlq: { confirmedTransfers: 0 },
    concurrencyConflicts: { total: 0, byCode: { '40P01': 0, '40001': 0, '55P03': 0, '57014': 0, '23505': 0 } },
    outboxLagMs: zeroTimeAggregate(),
    processingDurationMs: zeroTimeAggregate(),
    reconciliation: { divergences: 0 },
    pendingReference: { processed: 0, rejected: 0, rescheduled: 0 },
  };
}

/** Pure reducer used by the collector and deterministic boundary tests. */
export function reduceSaturatedCounter(current: number): number | undefined {
  if (!Number.isSafeInteger(current) || current < 0) return undefined;
  return current === MAX_SAFE ? MAX_SAFE : current + 1;
}

/** Pure atomic transition that preserves total === sum(byCode), including saturation. */
export function reduceConcurrencyConflict(
  current: OperationalMetricsConcurrencyAggregate,
  code: ConcurrencyMetricCode,
): OperationalMetricsConcurrencyAggregate | undefined {
  try {
    if (!CONCURRENCY_CODES.includes(code) || !Number.isSafeInteger(current.total) || current.total < 0) return undefined;
    const byCode = ownDataRecord(current.byCode);
    if (!byCode || !hasExactKeys(byCode, CONCURRENCY_CODES)) return undefined;
    let total = 0;
    for (const candidateCode of CONCURRENCY_CODES) {
      const value = byCode[candidateCode];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
      total += value;
      if (!Number.isSafeInteger(total)) return undefined;
    }
    if (total !== current.total) return undefined;
    if (current.total === MAX_SAFE) return current;
    const nextByCode = { ...byCode, [code]: (byCode[code] as number) + 1 } as Record<ConcurrencyMetricCode, number>;
    const nextTotal = current.total + 1;
    const nextSum = CONCURRENCY_CODES.reduce((sum, candidateCode) => sum + nextByCode[candidateCode], 0);
    if (nextSum !== nextTotal || !Number.isSafeInteger(nextTotal)) return undefined;
    return { total: nextTotal, byCode: nextByCode };
  } catch {
    return undefined;
  }
}

function bucketFor(sampleMs: number): keyof OperationalMetricsBuckets {
  if (sampleMs <= 5) return 'le5Ms';
  if (sampleMs <= 10) return 'le10Ms';
  if (sampleMs <= 25) return 'le25Ms';
  if (sampleMs <= 50) return 'le50Ms';
  if (sampleMs <= 100) return 'le100Ms';
  if (sampleMs <= 250) return 'le250Ms';
  if (sampleMs <= 500) return 'le500Ms';
  if (sampleMs <= 1000) return 'le1000Ms';
  return 'gt1000Ms';
}

/** Pure, atomic reducer for one valid temporal sample; undefined means no change. */
export function reduceTimeAggregate(
  current: OperationalMetricsTimeAggregate,
  sampleMs: number,
): OperationalMetricsTimeAggregate | undefined {
  if (!Number.isSafeInteger(sampleMs) || sampleMs < 0 || !validTimeAggregate(current) || current.count >= MAX_SAFE) return undefined;

  const bucket = bucketFor(sampleMs);
  const buckets = { ...current.buckets, [bucket]: current.buckets[bucket] + 1 };
  const count = current.count + 1;
  const candidate: OperationalMetricsTimeAggregate = {
    count,
    totalMs: Math.min(MAX_SAFE, current.totalMs + sampleMs),
    minMs: current.count === 0 ? sampleMs : Math.min(current.minMs, sampleMs),
    maxMs: current.count === 0 ? sampleMs : Math.max(current.maxMs, sampleMs),
    lastMs: sampleMs,
    buckets,
  };
  if (!validTimeAggregate(candidate)) return undefined;
  return candidate;
}

function ownDataRecord(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== 'string')) return undefined;
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

function validTimeAggregate(input: unknown): input is OperationalMetricsTimeAggregate {
  try {
    const aggregate = ownDataRecord(input);
    if (!aggregate || !hasExactKeys(aggregate, ['count', 'totalMs', 'minMs', 'maxMs', 'lastMs', 'buckets'])) return false;
    const count = aggregate['count'];
    const totalMs = aggregate['totalMs'];
    const minMs = aggregate['minMs'];
    const maxMs = aggregate['maxMs'];
    const lastMs = aggregate['lastMs'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
      || typeof totalMs !== 'number' || !Number.isSafeInteger(totalMs) || totalMs < 0
      || typeof minMs !== 'number' || !Number.isSafeInteger(minMs) || minMs < 0
      || typeof maxMs !== 'number' || !Number.isSafeInteger(maxMs) || maxMs < 0
      || typeof lastMs !== 'number' || !Number.isSafeInteger(lastMs) || lastMs < 0) return false;

    const buckets = ownDataRecord(aggregate['buckets']);
    const bucketKeys = ['le5Ms', 'le10Ms', 'le25Ms', 'le50Ms', 'le100Ms', 'le250Ms', 'le500Ms', 'le1000Ms', 'gt1000Ms'] as const;
    if (!buckets || !hasExactKeys(buckets, bucketKeys)) return false;
    let bucketTotal = 0;
    for (const key of bucketKeys) {
      const value = buckets[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
      bucketTotal += value;
      if (!Number.isSafeInteger(bucketTotal)) return false;
    }
    if (bucketTotal !== count) return false;
    if (count === 0) return totalMs === 0 && minMs === 0 && maxMs === 0 && lastMs === 0;
    return minMs <= lastMs && lastMs <= maxMs && maxMs <= totalMs;
  } catch {
    return false;
  }
}

function validObservation(input: unknown): OperationalMetricObservation | undefined {
  try {
    const record = ownDataRecord(input);
    if (!record || typeof record['type'] !== 'string') return undefined;
    switch (record['type']) {
      case 'wager-status':
        return hasExactKeys(record, ['type', 'status']) && WAGER_STATUSES.includes(record['status'] as WagerMetricStatus)
          ? { type: 'wager-status', status: record['status'] as WagerMetricStatus } : undefined;
      case 'duplicate':
        return hasExactKeys(record, ['type', 'kind']) && (record['kind'] === 'replay' || record['kind'] === 'conflict')
          ? { type: 'duplicate', kind: record['kind'] } : undefined;
      case 'retry-scheduled':
        return hasExactKeys(record, ['type', 'target']) && RETRY_TARGETS.includes(record['target'] as RetryMetricTarget)
          ? { type: 'retry-scheduled', target: record['target'] as RetryMetricTarget } : undefined;
      case 'concurrency-conflict':
        return hasExactKeys(record, ['type', 'code']) && CONCURRENCY_CODES.includes(record['code'] as ConcurrencyMetricCode)
          ? { type: 'concurrency-conflict', code: record['code'] as ConcurrencyMetricCode } : undefined;
      case 'dlq-transfer-confirmed':
        return hasExactKeys(record, ['type']) ? { type: 'dlq-transfer-confirmed' } : undefined;
      case 'outbox-publication-confirmed':
        return hasExactKeys(record, ['type', 'lagMs']) && typeof record['lagMs'] === 'number'
          && Number.isSafeInteger(record['lagMs']) && record['lagMs'] >= 0
          ? { type: 'outbox-publication-confirmed', lagMs: record['lagMs'] } : undefined;
      case 'processing-duration':
        return hasExactKeys(record, ['type', 'durationMs']) && typeof record['durationMs'] === 'number'
          && Number.isSafeInteger(record['durationMs']) && record['durationMs'] >= 0
          ? { type: 'processing-duration', durationMs: record['durationMs'] } : undefined;
      case 'pending-reference-resolution':
        return hasExactKeys(record, ['type', 'action']) && PENDING_ACTIONS.includes(record['action'] as typeof PENDING_ACTIONS[number])
          ? { type: 'pending-reference-resolution', action: record['action'] as typeof PENDING_ACTIONS[number] } : undefined;
      case 'reconciliation-divergence':
        return hasExactKeys(record, ['type']) ? { type: 'reconciliation-divergence' } : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotCopy(state: MutableSnapshot): OperationalMetricsSnapshot {
  return deepFreeze({
    scope: 'process',
    transactionsByStatus: { ...state.transactionsByStatus },
    duplicates: { ...state.duplicates },
    retries: { ...state.retries },
    dlq: { ...state.dlq },
    concurrencyConflicts: { total: state.concurrencyConflicts.total, byCode: { ...state.concurrencyConflicts.byCode } },
    outboxLagMs: { ...state.outboxLagMs, buckets: { ...state.outboxLagMs.buckets } },
    processingDurationMs: { ...state.processingDurationMs, buckets: { ...state.processingDurationMs.buckets } },
    reconciliation: { ...state.reconciliation },
    pendingReference: { ...state.pendingReference },
  });
}

export class DefaultOperationalMetricsCollector implements OperationalMetricsCollector {
  private readonly state = initialSnapshot();

  observe(input: OperationalMetricObservation): void {
    const observation = validObservation(input);
    if (!observation) return;
    switch (observation.type) {
      case 'wager-status':
        this.state.transactionsByStatus[observation.status] = reduceSaturatedCounter(this.state.transactionsByStatus[observation.status]) ?? this.state.transactionsByStatus[observation.status];
        return;
      case 'duplicate': {
        const key = observation.kind === 'replay' ? 'replays' : 'conflicts';
        this.state.duplicates[key] = reduceSaturatedCounter(this.state.duplicates[key]) ?? this.state.duplicates[key];
        return;
      }
      case 'retry-scheduled':
        this.state.retries[observation.target] = reduceSaturatedCounter(this.state.retries[observation.target]) ?? this.state.retries[observation.target];
        return;
      case 'concurrency-conflict': {
        const next = reduceConcurrencyConflict(this.state.concurrencyConflicts, observation.code);
        if (next) this.state.concurrencyConflicts = { total: next.total, byCode: { ...next.byCode } };
        return;
      }
      case 'dlq-transfer-confirmed':
        this.state.dlq.confirmedTransfers = reduceSaturatedCounter(this.state.dlq.confirmedTransfers) ?? this.state.dlq.confirmedTransfers;
        return;
      case 'outbox-publication-confirmed': {
        const next = reduceTimeAggregate(this.state.outboxLagMs, observation.lagMs);
        if (next) this.state.outboxLagMs = { ...next, buckets: { ...next.buckets } };
        return;
      }
      case 'processing-duration': {
        const next = reduceTimeAggregate(this.state.processingDurationMs, observation.durationMs);
        if (next) this.state.processingDurationMs = { ...next, buckets: { ...next.buckets } };
        return;
      }
      case 'pending-reference-resolution':
        this.state.pendingReference[observation.action] = reduceSaturatedCounter(this.state.pendingReference[observation.action]) ?? this.state.pendingReference[observation.action];
        return;
      case 'reconciliation-divergence':
        this.state.reconciliation.divergences = reduceSaturatedCounter(this.state.reconciliation.divergences) ?? this.state.reconciliation.divergences;
    }
  }

  snapshot(): OperationalMetricsSnapshot {
    return snapshotCopy(this.state);
  }
}

// GREEN-G2: transient synchronous identity guards; no observations or pending work are queued.
const activeMetricsInputs = new WeakSet<object>();
const handledMetricsPromises = new WeakSet<object>();
const metricsPromiseThen = Promise.prototype.then;
const discardMetricsResult = (_value?: unknown): void => {};

/** The intrinsic performs the native Promise brand check without reading result.then. */
function consumeMetricsPromise(result: object): boolean {
  if (handledMetricsPromises.has(result)) return true;
  try {
    metricsPromiseThen.call(result, discardMetricsResult, discardMetricsResult);
    handledMetricsPromises.add(result);
    return true;
  } catch {
    // Non-Promises (including proxies) fail the intrinsic brand check.
    return false;
  }
}

function consumeMetricsPromiseValue(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    consumeMetricsPromise(value);
  }
}

/** Deliberately shallow: custom thenables are never recursively assimilated. */
function consumeMetricsReturn(result: unknown): void {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return;
  if (consumeMetricsPromise(result)) return;
  try {
    const then: unknown = (result as { readonly then?: unknown }).then;
    if (typeof then !== 'function') return;
    const returned: unknown = Reflect.apply(then, result, [consumeMetricsPromiseValue, consumeMetricsPromiseValue]);
    consumeMetricsPromiseValue(returned);
  } catch { /* Best effort, including getters and throws after resolution. */ }
}

/** Optional observation boundary; delivery is synchronous, asynchronous results are never awaited. */
export function operationalMetricsEmitter(
  input?: OperationalMetricsInput,
): (observation: OperationalMetricObservation) => void {
  if (input === null || (typeof input !== 'object' && typeof input !== 'function')) return discardMetricsResult;
  let busy = false;
  return (observation): void => {
    if (busy || activeMetricsInputs.has(input)) return;
    busy = true;
    activeMetricsInputs.add(input);
    try {
      let result: unknown;
      if (typeof input === 'function') {
        result = input(observation);
      } else {
        const observe: unknown = input.observe;
        if (typeof observe !== 'function') return;
        result = Reflect.apply(observe, input, [observation]);
      }
      consumeMetricsReturn(result);
    } catch { /* Observability failures cannot replace the caller's result. */ }
    finally {
      activeMetricsInputs.delete(input);
      busy = false;
    }
  };
}
