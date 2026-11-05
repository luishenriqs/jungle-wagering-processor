import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { localSqsClient } from '../../modules/messaging/infrastructure/local-sqs-client';

export type HealthProbe = (signal: AbortSignal) => Promise<void>;
export interface HealthOptions { readonly postgres?: HealthProbe; readonly sqs?: HealthProbe }
type DependencyState = 'up' | 'down' | 'unknown';
export interface HealthResult {
  readonly status: 'ready' | 'not_ready' | 'draining';
  readonly dependencies: { readonly postgres: DependencyState; readonly sqs: DependencyState };
}
export function readinessTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env['HEALTH_READINESS_TIMEOUT_MS'] ?? '1500';
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 100 || Number(raw) > 10000) {
    throw new Error('Invalid HEALTH_READINESS_TIMEOUT_MS');
  }
  return Number(raw);
}
interface Flight {
  readonly stop: AbortController;
  readonly response: Promise<HealthResult>;
  readonly completion: Promise<void>;
}
/** Owns only HTTP health operations and its diagnostic SQS client, never workers or ORM. */
export class HealthReadiness {
  private draining = false;
  private flight: Flight | undefined;
  private client: SQSClient | undefined;
  private readonly timeout: number;
  private readonly env: Readonly<Record<string, string | undefined>>;
  constructor(private readonly postgres: HealthProbe, private readonly options: HealthOptions = {},
    env: Readonly<Record<string, string | undefined>> = process.env) {
    this.timeout = readinessTimeoutMs(env);
    // Retain only SQS configuration, not unrelated environment secrets.
    this.env = Object.fromEntries(['SQS_ENDPOINT', 'AWS_REGION', 'SQS_INPUT_QUEUE_NAME', 'SQS_DLQ_QUEUE_NAME',
      'SQS_EVENTS_QUEUE_NAME', 'SQS_MAX_RECEIVE_COUNT'].map(key => [key, env[key]]));
  }
  async check(): Promise<HealthResult> {
    if (this.draining) return this.drainingResult();
    const result = await (this.flight ?? this.begin()).response;
    return this.current(result);
  }
  current(result: HealthResult): HealthResult { return this.draining ? this.drainingResult() : result; }
  private begin(): Flight {
    const stop = new AbortController();
    const dependencies: { postgres: DependencyState; sqs: DependencyState } = { postgres: 'down', sqs: 'down' };
    let respond!: (result: HealthResult) => void;
    const response = new Promise<HealthResult>(resolve => { respond = resolve; });
    const snapshot = (): HealthResult => ({ status: !stop.signal.aborted && dependencies.postgres === 'up' && dependencies.sqs === 'up' ? 'ready' : 'not_ready', dependencies: { ...dependencies } });
    const abort = () => respond(this.draining ? this.drainingResult() : snapshot());
    stop.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop.abort(), this.timeout);
    const run = async (name: 'postgres' | 'sqs', probe: HealthProbe) => {
      try { await probe(stop.signal); if (!stop.signal.aborted) dependencies[name] = 'up'; }
      catch { dependencies[name] = 'down'; }
    };
    // Defer invocation until flight is installed, including for synchronous throws.
    const completion = Promise.resolve().then(async () => {
      if (stop.signal.aborted) return;
      await Promise.all([run('postgres', this.options.postgres ?? this.postgres), run('sqs', this.options.sqs ?? (signal => this.sqs(signal)))]);
    }).finally(() => {
      clearTimeout(timer); stop.signal.removeEventListener('abort', abort);
      respond(this.draining ? this.drainingResult() : snapshot());
      // HTTP timeout does not release ownership of an unfinished dependency.
      if (this.flight?.stop === stop) this.flight = undefined;
    });
    const flight = { stop, response, completion };
    this.flight = flight;
    return flight;
  }
  private async sqs(signal: AbortSignal): Promise<void> {
    const names = [this.env['SQS_INPUT_QUEUE_NAME'] ?? 'wager-transactions.fifo',
      this.env['SQS_DLQ_QUEUE_NAME'] ?? 'wager-transactions-dlq.fifo', this.env['SQS_EVENTS_QUEUE_NAME'] ?? 'wagering-events.fifo'];
    if (new Set(names).size !== 3 || !names.every(name => /^[A-Za-z0-9_-]{1,75}\.fifo$/.test(name))) throw new Error('Invalid health queue configuration');
    const maxReceiveCount = this.env['SQS_MAX_RECEIVE_COUNT'] ?? '5';
    if (!/^[1-9][0-9]*$/.test(maxReceiveCount) || Number(maxReceiveCount) > 1000) throw new Error('Invalid health redrive configuration');
    if (signal.aborted) throw new Error('Health cancelled');
    const client = this.client ??= localSqsClient(this.env);
    const settled = await Promise.allSettled(names.map(async name => {
      if (signal.aborted) throw new Error('Health cancelled');
      const queue = await client.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: signal });
      if (!queue.QueueUrl || signal.aborted) throw new Error('Health queue unavailable');
      const result = await client.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl,
        AttributeNames: ['QueueArn', 'FifoQueue', 'RedrivePolicy'] }), { abortSignal: signal });
      if (result.Attributes?.FifoQueue !== 'true' || !result.Attributes.QueueArn) throw new Error('Invalid health queue attributes');
      return result.Attributes;
    }));
    // A failed queue does not detach the other SDK requests from this flight.
    const attributes = settled.map(result => { if (result.status === 'rejected') throw new Error('Health queue unavailable'); return result.value; });
    const policy: unknown = JSON.parse(attributes[0]?.RedrivePolicy ?? 'null');
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || (policy as Record<string, unknown>)['deadLetterTargetArn'] !== attributes[1]?.QueueArn
      || !/^[1-9][0-9]*$/.test(String((policy as Record<string, unknown>)['maxReceiveCount']))
      || Number((policy as Record<string, unknown>)['maxReceiveCount']) !== Number(maxReceiveCount)) throw new Error('Invalid health redrive policy');
  }
  private drainingResult(): HealthResult { return { status: 'draining', dependencies: { postgres: 'unknown', sqs: 'unknown' } }; }
  async onModuleDestroy(): Promise<void> {
    this.draining = true;
    const flight = this.flight;
    flight?.stop.abort();
    // Run before ORM shutdown; do not close resources still owned by a probe.
    await flight?.completion;
  }
  async beforeApplicationShutdown(): Promise<void> { await this.onModuleDestroy(); }
  onApplicationShutdown(): void { this.client?.destroy(); this.client = undefined; }
}
