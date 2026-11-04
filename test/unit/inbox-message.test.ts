import { expect, test } from 'bun:test';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';

const at = new Date('2026-11-04T12:00:00.000Z');
const props = { consumerName: 'wagers', messageId: 'message', payloadHash: 'a'.repeat(64), receivedAt: at };

test('inbox reception, processing and logical duplicate keep original timestamp', () => {
  const inbox = InboxMessage.receive(props);
  expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(at);
  inbox.markProcessed(new Date(at.getTime() + 1000));
  expect(inbox.isProcessed()).toBe(true);
  expect(inbox.processedAt?.toISOString()).toBe(at.toISOString());
  expect(() => inbox.assertSamePayload(props.payloadHash)).not.toThrow();
  expect(() => inbox.assertSamePayload('b'.repeat(64))).toThrow();
});
test('inbox identity, dates and rehydration are protected', () => {
  const receivedAt = new Date(at);
  const inbox = InboxMessage.rehydrate({ ...props, receivedAt, processedAt: at });
  receivedAt.setFullYear(2000);
  inbox.receivedAt.setFullYear(2001);
  inbox.processedAt?.setFullYear(2002);
  expect(inbox.receivedAt.toISOString()).toBe(at.toISOString());
  expect(inbox.processedAt?.toISOString()).toBe(at.toISOString());
  expect(inbox.consumerName).toBe(props.consumerName);
  expect(inbox.messageId).toBe(props.messageId);
  expect(inbox.payloadHash).toBe(props.payloadHash);
  expect(Reflect.set(inbox, 'messageId', 'changed')).toBe(false);
});
test('inbox rejects invalid identity, hash, date without processing', () => {
  for (const change of [{ messageId: '' }, { consumerName: '' }, { payloadHash: 'bad' }, { receivedAt: new Date('invalid') }]) {
    expect(() => InboxMessage.receive({ ...props, ...change })).toThrow();
  }
  const inbox = InboxMessage.receive(props);
  expect(() => inbox.markProcessed(new Date('invalid'))).toThrow();
  expect(inbox.isProcessed()).toBe(false);
});
