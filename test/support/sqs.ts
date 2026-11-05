import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { localSqsClient } from '../../src/modules/messaging/infrastructure/local-sqs-client';
import { AwsSqsConsumerTransport } from '../../src/modules/messaging/infrastructure/aws-sqs-consumer-transport';
import { consumerConfig } from '../../src/modules/messaging/application/consumer-config';

/** Real LocalStack queues with unique per-test names. Never purges or deletes shared queues. */
export async function createSqsHarness() {
  const client = localSqsClient(); const prefix = `jungle_it_${randomUUID().replaceAll('-', '')}`;
  const created: { name: string; url: string }[] = [];
  const config = consumerConfig({ SQS_MAX_RECEIVE_COUNT: '3', SQS_WAIT_SECONDS: '0', SQS_VISIBILITY_TIMEOUT_SECONDS: '30', SQS_RETRY_MAX_SECONDS: '2' });
  const commandOptions = () => ({ abortSignal: AbortSignal.timeout(5000) });
  const close = async () => {
    try {
      for (const queue of [...created].reverse()) {
        if (!queue.name.startsWith(`${prefix}_`) || !prefix.match(/^jungle_it_[a-f0-9]{32}$/)) throw new Error('Refusing shared queue deletion');
        await client.send(new DeleteQueueCommand({ QueueUrl: queue.url }), commandOptions());
      }
    } finally { client.destroy(); }
  };
  try {
    const create = async (name: string, attributes: Record<string, string>) => {
      const response = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }), commandOptions());
      if (!response.QueueUrl) throw new Error('Missing test QueueUrl');
      created.push({ name, url: response.QueueUrl }); return response.QueueUrl;
    };
    const attrs = { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' };
    const dlqName = `${prefix}_dlq.fifo`; const inputName = `${prefix}_input.fifo`;
    const dlqUrl = await create(dlqName, attrs);
    const dlq = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }), commandOptions());
    if (!dlq.Attributes?.QueueArn) throw new Error('Missing test DLQ ARN');
    const inputUrl = await create(inputName, { ...attrs, RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.Attributes.QueueArn, maxReceiveCount: String(config.maxReceiveCount) }) });
    const transport = await AwsSqsConsumerTransport.connect(client, config, inputName, dlqName);
    return { client, prefix, config, transport, inputUrl, dlqUrl, inputName, dlqName, close,
      async send(body: string, groupId = 'wallet-test', dedupId = randomUUID()) {
        const sent = await client.send(new SendMessageCommand({ QueueUrl: inputUrl, MessageBody: body,
          MessageGroupId: groupId, MessageDeduplicationId: dedupId }), commandOptions());
        if (!sent.MessageId) throw new Error('Test SendMessage not confirmed');
        return sent.MessageId;
      },
      async receiveSource() {
        return until(async () => transport.receive());
      },
      async readDlq() {
        const result = await client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0, MessageSystemAttributeNames: ['All'] }), commandOptions());
        return result.Messages?.[0];
      },
      async removeTestDlq() {
        await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }), commandOptions());
        const index = created.findIndex(q => q.url === dlqUrl); if (index >= 0) created.splice(index, 1);
      },
    };
  } catch (error) {
    try { await close(); } catch { /* preserve setup error */ }
    throw error;
  }
}
export async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await read(); if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for real SQS delivery');
}
export type SqsHarness = Awaited<ReturnType<typeof createSqsHarness>>;
