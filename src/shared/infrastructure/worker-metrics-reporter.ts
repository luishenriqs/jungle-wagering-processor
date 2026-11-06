import { randomUUID } from 'node:crypto';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { OperationalMetricsCollector, OperationalMetricsSnapshot } from '../application/operational-metrics';

export type MetricsWorkerComponent = 'sqs-consumer' | 'outbox-publisher' | 'pending-reference-worker';
export interface WorkerMetricsReporterOptions {
  readonly intervalMs?: number;
  /** Test seam; production writes directly to stderr without awaiting its receipt. */
  readonly write?: (line: string) => void | Promise<unknown>;
}
export function workerMetricsIntervalMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env['WORKER_METRICS_INTERVAL_MS'] ?? '10000';
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) < 50 || Number(raw) > 3600000) throw new Error('Invalid WORKER_METRICS_INTERVAL_MS');
  return Number(raw);
}

const timeShape = { count: 0, totalMs: 0, minMs: 0, maxMs: 0, lastMs: 0,
  buckets: { le5Ms: 0, le10Ms: 0, le25Ms: 0, le50Ms: 0, le100Ms: 0, le250Ms: 0, le500Ms: 0, le1000Ms: 0, gt1000Ms: 0 } };
// Schema only: no second collector or mutable copy of the process counters.
const template: OperationalMetricsSnapshot = {
  scope: 'process', transactionsByStatus: { PROCESSED: 0, REJECTED: 0, PENDING_REFERENCE: 0, FAILED: 0 },
  duplicates: { replays: 0, conflicts: 0 },
  retries: { wagerUow: 0, walletUow: 0, pendingReference: 0, sqsConsumer: 0, outboxPublisher: 0 },
  dlq: { confirmedTransfers: 0 },
  concurrencyConflicts: { total: 0, byCode: { '40P01': 0, '40001': 0, '55P03': 0, '57014': 0, '23505': 0 } },
  outboxLagMs: timeShape, processingDurationMs: timeShape, reconciliation: { divergences: 0 },
  pendingReference: { processed: 0, rejected: 0, rescheduled: 0 },
};
const promiseThen = Promise.prototype.then;

/** A closed projection prevents custom collectors/getters/toJSON from leaking data. */
function project(value: unknown, shape: unknown): unknown {
  if (typeof shape === 'string') {
    if (value !== shape) throw new Error('Invalid metric scope');
    return value;
  }
  if (typeof shape === 'number') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid metric counter');
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metric record');
  const fields = Object.keys(shape as object);
  if (Reflect.ownKeys(value).length !== fields.length) throw new Error('Unexpected metric fields');
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid metric descriptor');
    result[field] = project(descriptor.value, (shape as Record<string, unknown>)[field]);
  }
  return result;
}

/** One reporter/collector per standalone context; no sample queue or financial I/O. */
export class WorkerMetricsReporter implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly executionId = randomUUID();
  private readonly intervalMs: number;
  private readonly write: NonNullable<WorkerMetricsReporterOptions['write']>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private pending = false;
  private lastSnapshot: string | undefined;
  constructor(private readonly collector: OperationalMetricsCollector, private readonly component: MetricsWorkerComponent,
    options: WorkerMetricsReporterOptions = {}) {
    if (!['sqs-consumer', 'outbox-publisher', 'pending-reference-worker'].includes(component)) throw new Error('Invalid metrics component');
    this.intervalMs = options.intervalMs ?? workerMetricsIntervalMs();
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 50 || this.intervalMs > 3600000) throw new Error('Invalid WORKER_METRICS_INTERVAL_MS');
    this.write = options.write ?? (line => Bun.write(Bun.stderr, line));
  }
  onApplicationBootstrap(): void { this.start(); }
  onApplicationShutdown(): void { this.stop(); }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref();
    this.flush();
  }
  flush(): void {
    if (!this.running || this.pending) return;
    this.pending = true; // Also fences synchronous writer/collector reentry.
    try {
      const snapshot = project(this.collector.snapshot(), template);
      const encoded = JSON.stringify(snapshot);
      if (encoded === this.lastSnapshot) { this.pending = false; return; }
      const line = JSON.stringify({ type: 'OperationalMetricsSnapshot', version: 1, component: this.component,
        executionId: this.executionId, pid: process.pid, timestamp: new Date().toISOString(), snapshot }) + '\n';
      const receipt = this.write(line);
      const success = () => { this.lastSnapshot = encoded; this.pending = false; };
      const failure = () => { this.pending = false; };
      if (receipt === undefined) success();
      else {
        // Native brand check: never recursively assimilate custom thenables or read receipt.then.
        // One reaction at most is retained while a native writer Promise remains pending.
        try { promiseThen.call(receipt, success, failure); } catch { failure(); }
      }
    } catch { this.pending = false; } // Snapshot/serialization/writer failures remain fail-open.
  }
  stop(): void {
    if (!this.running) return;
    clearInterval(this.timer); this.timer = undefined;
    this.flush(); // Best effort: skip unchanged snapshots or an outstanding receipt; never await.
    this.running = false;
  }
}
