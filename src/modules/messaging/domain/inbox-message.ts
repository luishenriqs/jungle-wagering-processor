import { IdempotencyConflictError, InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { dateCopy, requireText } from '../../../shared/domain/validation';

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}
export interface InboxMessageState extends ReceiveInboxProps { readonly processedAt?: Date | undefined }
export class InboxMessage {
  readonly #props: ReceiveInboxProps;
  #processedAt: Date | undefined;
  private constructor(state: InboxMessageState) {
    this.#props = Object.freeze({ ...state, receivedAt: dateCopy(state.receivedAt) });
    this.#processedAt = state.processedAt && dateCopy(state.processedAt);
    Object.freeze(this);
  }
  static receive(props: ReceiveInboxProps): InboxMessage {
    requireText(props.messageId, 'messageId');
    requireText(props.consumerName, 'consumerName');
    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) throw new InvalidDomainInputError('Expected lowercase SHA-256 payload hash');
    return new InboxMessage(props);
  }
  static rehydrate(state: InboxMessageState): InboxMessage { return new InboxMessage(state); }
  get messageId(): string { return this.#props.messageId; }
  get consumerName(): string { return this.#props.consumerName; }
  get payloadHash(): string { return this.#props.payloadHash; }
  get receivedAt(): Date { return dateCopy(this.#props.receivedAt); }
  get processedAt(): Date | undefined { return this.#processedAt && dateCopy(this.#processedAt); }
  isProcessed(): boolean { return this.#processedAt !== undefined; }
  markProcessed(at: Date): void {
    if (!this.isProcessed()) this.#processedAt = dateCopy(at);
  }
  assertSamePayload(payloadHash: string): void {
    if (payloadHash !== this.payloadHash) throw new IdempotencyConflictError('Inbox message payload conflicts');
  }
}
