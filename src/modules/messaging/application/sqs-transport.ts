/** SQS transport identity and receipt are deliberately separate from the business envelope. */
export interface ReceivedWagerMessage {
  readonly body: string;
  readonly transportMessageId: string;
  readonly receiptHandle: string;
  readonly receiveCount: number;
}
export interface SqsConsumerTransport {
  receive(signal?: AbortSignal): Promise<ReceivedWagerMessage | undefined>;
  acknowledge(receiptHandle: string): Promise<void>;
  retry(receiptHandle: string, delaySeconds: number): Promise<void>;
  deadLetter(body: string, groupId: string, deduplicationId: string): Promise<void>;
}
