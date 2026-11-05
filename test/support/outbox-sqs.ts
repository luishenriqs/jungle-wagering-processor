import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { localSqsClient } from '../../src/modules/messaging/infrastructure/local-sqs-client';
import { AwsSqsOutboxTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-outbox-transport';

export async function createOutboxSqsHarness() {
  const name = `jungle_it_${randomUUID().replaceAll('-', '')}_events.fifo`;
  const client = localSqsClient(); let url: string | undefined;
  try {
    const queue = await client.send(new CreateQueueCommand({ QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '5' } }), { abortSignal: AbortSignal.timeout(5000) });
    url = queue.QueueUrl; if (!url) throw new Error('Missing isolated events queue URL');
    const queueUrl = url;
    const transport = await AwsSqsOutboxTransport.connect(client, 3000, name);
    return { client, name, transport,
      async read() {
        const messages = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0, MessageSystemAttributeNames: ['All'] }), { abortSignal: AbortSignal.timeout(5000) });
        const records: { payload: Record<string, unknown>; groupId: string | undefined; dedupId: string | undefined }[] = [];
        for (const m of messages.Messages ?? []) {
          if (!m.Body || !m.ReceiptHandle) throw new Error('Incomplete events delivery');
          records.push({ payload: JSON.parse(m.Body) as Record<string, unknown>, groupId: m.Attributes?.MessageGroupId, dedupId: m.Attributes?.MessageDeduplicationId });
          await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }), { abortSignal: AbortSignal.timeout(5000) });
        }
        return records;
      },
      async close() {
        if (!/^jungle_it_[a-f0-9]{32}_events\.fifo$/.test(name)) throw new Error('Refusing shared queue deletion');
        try { await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }), { abortSignal: AbortSignal.timeout(5000) }); }
        finally { client.destroy(); }
      },
    };
  } catch (error) {
    try { if (url) await client.send(new DeleteQueueCommand({ QueueUrl: url }), { abortSignal: AbortSignal.timeout(5000) }); }
    finally { client.destroy(); }
    throw error;
  }
}
export type OutboxSqsHarness = Awaited<ReturnType<typeof createOutboxSqsHarness>>;
