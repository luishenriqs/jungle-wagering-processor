import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConsumerTransport, ReceivedWagerMessage } from '../application/sqs-transport';
import type { ConsumerConfig } from '../application/consumer-config';

export class AwsSqsConsumerTransport implements SqsConsumerTransport {
  constructor(private readonly client: SQSClient, private readonly inputUrl: string, private readonly dlqUrl: string,
    private readonly config: ConsumerConfig) {}
  static async connect(client: SQSClient, config: ConsumerConfig, inputName = 'wager-transactions.fifo', dlqName = 'wager-transactions-dlq.fifo') {
    if (inputName === dlqName || ![inputName, dlqName].every(n => /^[A-Za-z0-9_-]{1,75}\.fifo$/.test(n))) throw new Error('Invalid FIFO queue names');
    const resolve = async (name: string) => {
      const queue = await client.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: AbortSignal.timeout(config.requestTimeoutMs) });
      if (!queue.QueueUrl) throw new Error('Missing SQS QueueUrl');
      const { Attributes: attrs } = await client.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl,
        AttributeNames: ['QueueArn', 'FifoQueue', 'RedrivePolicy'] }), { abortSignal: AbortSignal.timeout(config.requestTimeoutMs) });
      if (!attrs?.QueueArn || attrs.FifoQueue !== 'true') throw new Error('Expected FIFO queue');
      return { url: queue.QueueUrl, attrs };
    };
    const input = await resolve(inputName); const dlq = await resolve(dlqName);
    const policy: unknown = JSON.parse(input.attrs.RedrivePolicy ?? 'null');
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || (policy as Record<string, unknown>)['deadLetterTargetArn'] !== dlq.attrs.QueueArn
      || Number((policy as Record<string, unknown>)['maxReceiveCount']) !== config.maxReceiveCount) throw new Error('SQS redrive policy/config mismatch');
    return new AwsSqsConsumerTransport(client, input.url, dlq.url, config);
  }
  async receive(signal?: AbortSignal): Promise<ReceivedWagerMessage | undefined> {
    const timeout = AbortSignal.timeout(this.config.waitSeconds * 1000 + this.config.requestTimeoutMs);
    const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.inputUrl, MaxNumberOfMessages: 1,
      WaitTimeSeconds: this.config.waitSeconds, VisibilityTimeout: this.config.visibilitySeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'] }), { abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const message = result.Messages?.[0];
    if (!message) return undefined;
    if (!message.ReceiptHandle || !message.MessageId) throw new Error('Incomplete SQS delivery identity');
    const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid SQS receive count');
    return { body: message.Body ?? '', transportMessageId: message.MessageId, receiptHandle: message.ReceiptHandle, receiveCount: count };
  }
  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.inputUrl, ReceiptHandle: receiptHandle }),
      { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
  }
  async retry(receiptHandle: string, delaySeconds: number): Promise<void> {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 43200) throw new Error('Invalid visibility delay');
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.inputUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: delaySeconds }),
      { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
  }
  async deadLetter(body: string, groupId: string, deduplicationId: string): Promise<void> {
    const sent = await this.client.send(new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: body,
      MessageGroupId: groupId, MessageDeduplicationId: deduplicationId }), { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    if (!sent.MessageId) throw new Error('DLQ send was not confirmed');
  }
}
