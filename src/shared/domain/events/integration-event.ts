import { dateCopy, immutableJson, requireText } from '../validation';

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
}
export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}
export interface EventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<T>;
}
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly #props: IntegrationEventProps<T>;
  protected constructor(props: IntegrationEventProps<T>) {
    for (const field of ['eventId', 'aggregateId', 'correlationId'] as const) requireText(props[field], field);
    if (props.causationId !== undefined) requireText(props.causationId, 'causationId');
    this.#props = Object.freeze({ ...props, occurredAt: dateCopy(props.occurredAt), data: immutableJson(props.data) as T });
  }
  get eventId(): string { return this.#props.eventId; }
  get aggregateId(): string { return this.#props.aggregateId; }
  get correlationId(): string { return this.#props.correlationId; }
  get causationId(): string | undefined { return this.#props.causationId; }
  get occurredAt(): Date { return dateCopy(this.#props.occurredAt); }
  get data(): Readonly<T> { return this.#props.data; }
  toJSON(): EventEnvelope<T> {
    return { eventId: this.eventId, eventType: this.eventType, version: this.version, aggregateId: this.aggregateId,
      correlationId: this.correlationId, ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(), data: this.data };
  }
}
