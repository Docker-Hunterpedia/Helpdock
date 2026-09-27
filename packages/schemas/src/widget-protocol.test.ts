import { describe, expect, it } from 'vitest';
import {
  canonicalIdentityJson,
  signedIdentitySchema,
  WIDGET_EVENT_PAYLOADS,
  WIDGET_EVENTS,
  widgetMessagesQuerySchema,
  widgetPrechatAnswersSchema,
  widgetSendRequestSchema,
  widgetStartRequestSchema,
} from './widget-protocol.js';

const CLIENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000cc';

describe('canonicalIdentityJson', () => {
  it('writes the keys in a fixed order, whatever order they were built in', () => {
    expect(canonicalIdentityJson({ ts: 1, name: 'Mona', email: 'm@x.io', user_id: 'u-1' })).toBe(
      '{"user_id":"u-1","email":"m@x.io","name":"Mona","ts":1}',
    );
    expect(canonicalIdentityJson({ ts: 1, user_id: 'u-1' })).toBe('{"user_id":"u-1","ts":1}');
  });
});

describe('signedIdentitySchema', () => {
  it('wants a lower-case hex SHA-256 signature', () => {
    const payload = { user_id: 'u-1', ts: 1 };

    expect(signedIdentitySchema.safeParse({ payload, signature: 'a'.repeat(64) }).success).toBe(
      true,
    );
    expect(signedIdentitySchema.safeParse({ payload, signature: 'A'.repeat(64) }).success).toBe(
      false,
    );
  });
});

describe('the send requests', () => {
  it('needs text or an attachment for a message, and text for the first one', () => {
    expect(widgetSendRequestSchema.safeParse({ clientId: CLIENT, text: ' ' }).success).toBe(false);
    expect(
      widgetSendRequestSchema.safeParse({ clientId: CLIENT, text: '', attachmentIds: [CLIENT] })
        .success,
    ).toBe(true);
    expect(widgetStartRequestSchema.safeParse({ clientId: CLIENT, text: '' }).success).toBe(false);
    expect(widgetStartRequestSchema.parse({ clientId: CLIENT, text: ' hi ' }).text).toBe('hi');
  });

  it('defaults a catch-up to the whole thread, a hundred at a time', () => {
    expect(widgetMessagesQuerySchema.parse({})).toEqual({ after: 0, limit: 100 });
    expect(widgetMessagesQuerySchema.parse({ after: '7' }).after).toBe(7);
  });

  it('keeps custom pre-chat answers as typed', () => {
    expect(widgetPrechatAnswersSchema.parse({ custom: { plan: 'pro', seats: 3 } }).custom).toEqual({
      plan: 'pro',
      seats: 3,
    });
  });
});

describe('WIDGET_EVENT_PAYLOADS', () => {
  it('has a schema for every event the server sends', () => {
    expect(Object.keys(WIDGET_EVENT_PAYLOADS).sort()).toEqual(
      [
        WIDGET_EVENTS.message,
        WIDGET_EVENTS.receipt,
        WIDGET_EVENTS.typing,
        WIDGET_EVENTS.presence,
        WIDGET_EVENTS.queue,
        WIDGET_EVENTS.conversation,
      ].sort(),
    );
  });
});
