import { expect, test } from 'bun:test';
import { entrypointIsolation } from '../support/entrypoint-isolation';

const env = { JUNGLE_ENTRYPOINT_SMOKE: 'yes', JUNGLE_TEST_SCHEMA: `jungle_it_${'a'.repeat(32)}`,
  DATABASE_URL: 'postgresql://jungle_test@127.0.0.1:5434/jungle_test', TEST_DATABASE_URL: 'postgresql://jungle_test@127.0.0.1:5434/jungle_test',
  SQS_ENDPOINT: 'http://127.0.0.1:4566', SQS_INPUT_QUEUE_NAME: `jungle_it_${'b'.repeat(32)}_input.fifo`,
  SQS_DLQ_QUEUE_NAME: `jungle_it_${'b'.repeat(32)}_dlq.fifo`, SQS_EVENTS_QUEUE_NAME: `jungle_it_${'c'.repeat(32)}_events.fifo` };
test('entrypoint guard accepts explicit isolated resources', () => {
  expect(entrypointIsolation(env)).toEqual({ url: env.DATABASE_URL, schema: env.JUNGLE_TEST_SCHEMA });
});
test.each([
  { JUNGLE_ENTRYPOINT_SMOKE: 'no' }, { JUNGLE_TEST_SCHEMA: 'public' }, { DATABASE_URL: 'postgresql://localhost/jungle_dev' },
  { DATABASE_URL: 'postgresql://external/jungle_test', TEST_DATABASE_URL: 'postgresql://external/jungle_test' },
  { SQS_INPUT_QUEUE_NAME: 'wager-transactions.fifo' }, { SQS_DLQ_QUEUE_NAME: 'wager-transactions-dlq.fifo' },
  { SQS_EVENTS_QUEUE_NAME: 'wagering-events.fifo' }, { SQS_ENDPOINT: 'https://sqs.us-east-1.amazonaws.com' },
  { DATABASE_URL: `${env.DATABASE_URL}?options=unsafe`, TEST_DATABASE_URL: `${env.DATABASE_URL}?options=unsafe` },
])('entrypoint guard rejects unsafe resource configuration %j before spawn', patch => {
  expect(() => entrypointIsolation({ ...env, ...patch })).toThrow();
});
