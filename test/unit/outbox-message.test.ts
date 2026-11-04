import { expect, test } from 'bun:test';
import { IntegrationEvent, type IntegrationEventProps } from '../../src/shared/domain/events/integration-event';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';

class TestEvent extends IntegrationEvent<{ nested: { amount: string }; tags: string[] }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<{ nested: { amount: string }; tags: string[] }>) { super(props); Object.freeze(this); }
  static create(data = { nested: { amount: '1.00' }, tags: ['original'] }) {
    return new TestEvent({ eventId: 'event', aggregateId: 'wallet', correlationId: 'correlation', occurredAt: at, data });
  }
}
const at = new Date('2026-11-04T12:00:00.000Z');
const state = { id: 'event', aggregateId: 'wallet', eventType: 'TestEvent', payload: { nested: { value: 'original' } }, occurredAt: at, attempts: 3, nextAttemptAt: new Date(at.getTime() + 5000) };

test('enqueue persists stable event envelope, no publication side effect', () => {
  const event = TestEvent.create();
  const outbox = OutboxMessage.enqueue(event);
  expect(outbox.id).toBe(event.eventId);
  expect(outbox.aggregateId).toBe('wallet');
  expect(outbox.eventType).toBe('TestEvent');
  expect(outbox.attempts).toBe(0);
  expect(outbox.payload).toEqual({ ...event.toJSON() });
  expect(outbox.isPending()).toBe(true);
  expect(outbox.isDue(at)).toBe(true);
  expect(outbox.isDue(new Date(at.getTime() - 1))).toBe(false);
});
test('exponential backoff is deterministic and capped without dropping events', () => {
  const outbox = OutboxMessage.enqueue(TestEvent.create(), { baseDelayMs: 100, maxDelayMs: 500 });
  for (const delay of [100, 200, 400, 500, 500, 500]) {
    outbox.scheduleRetry(at);
    expect(outbox.nextAttemptAt.getTime()).toBe(at.getTime() + delay);
    expect(outbox.isDue(new Date(at.getTime() + delay - 1))).toBe(false);
    expect(outbox.isDue(new Date(at.getTime() + delay))).toBe(true);
  }
  expect(outbox.attempts).toBe(6);
  expect(outbox.isPending()).toBe(true);
  expect(outbox.payload['eventId']).toBe('event');
});
test('published is terminal for local retry/publication transitions', () => {
  const outbox = OutboxMessage.enqueue(TestEvent.create());
  outbox.markPublished(at);
  expect(outbox.isPending()).toBe(false);
  expect(outbox.isDue(at)).toBe(false);
  expect(outbox.publishedAt?.toISOString()).toBe(at.toISOString());
  expect(() => outbox.scheduleRetry(at)).toThrow();
  expect(() => outbox.markPublished(at)).toThrow();
});
test('rehydration retains retry, publication, deep payload and dates', () => {
  const occurredAt = new Date(at);
  const input = { ...state, occurredAt, payload: { nested: { value: 'original' } } };
  const outbox = OutboxMessage.rehydrate(input);
  occurredAt.setFullYear(2000);
  input.payload.nested.value = 'changed';
  outbox.occurredAt.setFullYear(2001);
  outbox.nextAttemptAt.setFullYear(2002);
  expect(outbox.occurredAt.toISOString()).toBe(at.toISOString());
  expect(outbox.nextAttemptAt.getTime()).toBe(at.getTime() + 5000);
  expect(outbox.attempts).toBe(3);
  expect(outbox.payload).toEqual({ nested: { value: 'original' } });
  expect(Reflect.set(outbox.payload, 'changed', true)).toBe(false);
  expect(Reflect.set(outbox, 'attempts', 0)).toBe(false);
  const published = OutboxMessage.rehydrate({ ...state, publishedAt: at });
  published.publishedAt?.setFullYear(2000);
  expect(published.isPending()).toBe(false);
  expect(published.publishedAt?.toISOString()).toBe(at.toISOString());
});
test('invalid policy and date cannot partially schedule/publish', () => {
  for (const policy of [{ baseDelayMs: 0, maxDelayMs: 100 }, { baseDelayMs: 100, maxDelayMs: 50 }, { baseDelayMs: Infinity, maxDelayMs: Infinity }]) expect(() => OutboxMessage.enqueue(TestEvent.create(), policy)).toThrow();
  const outbox = OutboxMessage.enqueue(TestEvent.create());
  expect(() => outbox.scheduleRetry(new Date('invalid'))).toThrow();
  expect(() => outbox.markPublished(new Date('invalid'))).toThrow();
  expect(outbox.attempts).toBe(0);
  expect(outbox.isPending()).toBe(true);
});
test('base event protects dates, nested payload and arrays from caller mutations', () => {
  const input = { nested: { amount: '1.00' }, tags: ['original'] };
  const event = TestEvent.create(input);
  input.nested.amount = '9.00';
  input.tags.push('other');
  event.occurredAt.setFullYear(2000);
  expect(event.data.nested.amount).toBe('1.00');
  expect(event.data.tags).toEqual(['original']);
  expect(() => event.data.tags.push('changed')).toThrow();
  expect(event.toJSON().occurredAt).toBe(at.toISOString());
  expect(event.toJSON()).not.toHaveProperty('causationId');
});
