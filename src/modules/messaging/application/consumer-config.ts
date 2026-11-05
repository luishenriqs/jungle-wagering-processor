export interface ConsumerConfig {
  readonly consumerName: string;
  readonly maxReceiveCount: number;
  readonly visibilitySeconds: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly waitSeconds: number;
  readonly requestTimeoutMs: number;
}
export function consumerConfig(env: Readonly<Record<string, string | undefined>> = process.env): ConsumerConfig {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if ((raw !== undefined && !/^(0|[1-9][0-9]*)$/.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${key}`);
    }
    return value;
  };
  const consumerName = env['SQS_CONSUMER_NAME'] ?? 'wager-transactions-consumer';
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(consumerName)) throw new Error('Invalid SQS_CONSUMER_NAME');
  const config = { consumerName, maxReceiveCount: integer('SQS_MAX_RECEIVE_COUNT', 5, 1, 1000),
    visibilitySeconds: integer('SQS_VISIBILITY_TIMEOUT_SECONDS', 120, 1, 43200),
    retryBaseSeconds: integer('SQS_RETRY_BASE_SECONDS', 1, 1, 43200),
    retryMaxSeconds: integer('SQS_RETRY_MAX_SECONDS', 60, 1, 43200),
    waitSeconds: integer('SQS_WAIT_SECONDS', 20, 0, 20),
    requestTimeoutMs: integer('SQS_REQUEST_TIMEOUT_MS', 3000, 1, 60000) };
  if (config.retryMaxSeconds < config.retryBaseSeconds) throw new Error('Retry maximum must cover base');
  return Object.freeze(config);
}
export function consumerRetrySeconds(attempt: number, config: ConsumerConfig): number {
  return Math.min(config.retryMaxSeconds, config.retryBaseSeconds * 2 ** Math.min(Math.max(attempt - 1, 0), 53));
}
