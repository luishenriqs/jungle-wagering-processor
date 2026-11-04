import type { IntegrationEvent } from '../../../shared/domain/events/integration-event';
import { InvalidDomainInputError, InvalidMessageStateError } from '../../../shared/domain/domain-errors';
import { dateCopy, immutableJson, requireText } from '../../../shared/domain/validation';

export interface RetryPolicy { readonly baseDelayMs: number; readonly maxDelayMs: number }
export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt?: Date | undefined;
}
const DEFAULT_RETRY: RetryPolicy = Object.freeze({ baseDelayMs: 1000, maxDelayMs: 60000 });
export class OutboxMessage {
  #state: OutboxMessageState;
  readonly #retry: RetryPolicy;
  private constructor(state: OutboxMessageState, retry: RetryPolicy) {
    if (!Number.isSafeInteger(retry.baseDelayMs) || !Number.isSafeInteger(retry.maxDelayMs)
      || retry.baseDelayMs <= 0 || retry.maxDelayMs < retry.baseDelayMs) throw new InvalidDomainInputError('Invalid retry policy');
    this.#retry = Object.freeze({ ...retry });
    this.#state = Object.freeze({ ...state, payload: immutableJson(state.payload), occurredAt: dateCopy(state.occurredAt),
      nextAttemptAt: dateCopy(state.nextAttemptAt), publishedAt: state.publishedAt && dateCopy(state.publishedAt) });
    Object.freeze(this);
  }
  static enqueue(event: IntegrationEvent<unknown>, retry: RetryPolicy = DEFAULT_RETRY): OutboxMessage {
    requireText(event.eventId, 'eventId');
    return new OutboxMessage({ id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: { ...event.toJSON() }, occurredAt: event.occurredAt, attempts: 0, nextAttemptAt: event.occurredAt }, retry);
  }
  static rehydrate(state: OutboxMessageState, retry: RetryPolicy = DEFAULT_RETRY): OutboxMessage { return new OutboxMessage(state, retry); }
  get id(): string { return this.#state.id; }
  get aggregateId(): string { return this.#state.aggregateId; }
  get eventType(): string { return this.#state.eventType; }
  get payload(): Readonly<Record<string, unknown>> { return this.#state.payload; }
  get occurredAt(): Date { return dateCopy(this.#state.occurredAt); }
  get attempts(): number { return this.#state.attempts; }
  get nextAttemptAt(): Date { return dateCopy(this.#state.nextAttemptAt); }
  get publishedAt(): Date | undefined { return this.#state.publishedAt && dateCopy(this.#state.publishedAt); }
  isPending(): boolean { return this.#state.publishedAt === undefined; }
  isDue(now: Date): boolean { return this.isPending() && this.nextAttemptAt.getTime() <= dateCopy(now).getTime(); }
  markPublished(at: Date): void {
    this.assertPending();
    this.#state = Object.freeze({ ...this.#state, publishedAt: dateCopy(at) });
  }
  scheduleRetry(now: Date): void {
    this.assertPending();
    if (!Number.isSafeInteger(this.attempts + 1)) throw new InvalidDomainInputError('Retry attempts overflow');
    const delay = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** Math.min(this.attempts, 53));
    const nextAttemptAt = dateCopy(new Date(dateCopy(now).getTime() + delay));
    this.#state = Object.freeze({ ...this.#state, attempts: this.attempts + 1, nextAttemptAt });
  }
  private assertPending(): void { if (!this.isPending()) throw new InvalidMessageStateError('Outbox already published'); }
}
