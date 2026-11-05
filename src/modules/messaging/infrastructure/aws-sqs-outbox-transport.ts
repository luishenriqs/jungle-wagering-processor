import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand, type SendMessageCommandInput, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxTransport } from '../application/outbox-publisher';
import type { OutboxMessage } from '../domain/outbox-message';

export function outboxSendInput(message: OutboxMessage, queueUrl: string): SendMessageCommandInput {
  if (message.payload['eventId'] !== message.id || message.payload['aggregateId'] !== message.aggregateId
    || message.payload['eventType'] !== message.eventType) throw new Error('Outbox envelope identity mismatch');
  return { QueueUrl: queueUrl, MessageBody: JSON.stringify(message.payload), MessageGroupId: message.aggregateId,
    MessageDeduplicationId: message.id };
}
export class AwsSqsOutboxTransport implements OutboxTransport {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}
  static async connect(client: SQSClient, timeoutMs: number, name = 'wagering-events.fifo') {
    if (!/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(name)) throw new Error('Invalid Outbox FIFO queue name');
    const queue = await client.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    if (!queue.QueueUrl) throw new Error('Missing events QueueUrl');
    const attrs = await client.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl, AttributeNames: ['FifoQueue'] }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    if (attrs.Attributes?.FifoQueue !== 'true') throw new Error('Events queue must be FIFO');
    return new AwsSqsOutboxTransport(client, queue.QueueUrl);
  }
  async publish(message: OutboxMessage, signal: AbortSignal): Promise<void> {
    const result = await this.client.send(new SendMessageCommand(outboxSendInput(message, this.queueUrl)), { abortSignal: signal });
    if (!result.MessageId) throw new Error('Event send not confirmed');
  }
}
