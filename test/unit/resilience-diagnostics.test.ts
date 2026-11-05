import { expect, test } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { phaseFailure, type ResilienceRecord } from '../support/resilience-client';
import { consumerConfig } from '../../src/modules/messaging/application/consumer-config';
import { AwsSqsConsumerTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-consumer-transport';
import { SqsWagerConsumer } from '../../src/modules/messaging/application/sqs-wager-consumer';

test('phase timeout identifies the restarted consumer and expected ACK without dumping message data', () => {
  const record = { type: 'phase', phase: 'poll-started', body: 'private-body', receiptHandle: 'private-receipt' };
  const error = phaseFailure('Worker phase timeout', 'acked', 'consumer-normal', 42, [record]);
  expect(error.message).toContain('expected=acked');
  expect(error.message).toContain('mode=consumer-normal; pid=42');
  expect(error.message).toContain('phases=[poll-started]');
  expect(error.message).not.toContain('private-body');
  expect(error.message).not.toContain('private-receipt');
});

test('phase diagnostics bound history and distinguish startup from an exited child', () => {
  const records: ResilienceRecord[] = Array.from({ length: 30 }, (_, i) => ({ type: 'phase', phase: `phase-${i}` }));
  const message = phaseFailure('Worker exited before expected phase', 'ready', 'consumer-idle', undefined, records).message;
  expect(message).toContain('Worker exited before expected phase; expected=ready');
  expect(message).toContain('pid=unknown');
  expect(message).not.toContain('phase-13');
  expect(message).toContain('phase-14 -> phase-15');
  expect(message).toContain('phase-29');
});

test('SDK receive propagates shutdown abort and consumer starts no further receive or financial work', async () => {
  let entered!: () => void;
  const receiving = new Promise<void>(resolve => { entered = resolve; });
  let receives = 0; let aborts = 0; let financialCalls = 0;
  const client = new SQSClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:4566', maxAttempts: 1,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: { handle: async (_request: unknown, options?: { abortSignal?: AbortSignal }): Promise<never> => {
      receives++;
      return new Promise((_resolve, reject) => {
        const abort = () => { aborts++; reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
        options?.abortSignal?.addEventListener('abort', abort, { once: true });
        entered();
        if (options?.abortSignal?.aborted) abort();
      });
    } },
  });
  const config = consumerConfig({});
  const transport = new AwsSqsConsumerTransport(client, 'http://127.0.0.1:4566/input.fifo', 'http://127.0.0.1:4566/dlq.fifo', config);
  const consumer = new SqsWagerConsumer({ execute: async () => { financialCalls++; throw new Error('Unexpected financial call'); } },
    transport, { now: () => new Date() }, config, () => {});
  const stop = new AbortController();
  try {
    const running = consumer.run(stop.signal);
    await receiving; stop.abort(); await running;
    expect(aborts).toBe(1);
    expect(receives).toBe(1);
    expect(financialCalls).toBe(0);
  } finally { stop.abort(); client.destroy(); }
});
