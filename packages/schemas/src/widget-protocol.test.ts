import { describe, expect, it } from 'vitest';
import {
  canonicalIdentityJson,
  signedIdentitySchema,
  WIDGET_CSAT_COMMENT_MAX,
  WIDGET_EVENT_PAYLOADS,
  WIDGET_EVENTS,
  widgetConfigQuerySchema,
  widgetConversationEventSchema,
  widgetConversationHoursSchema,
  widgetConversationSchema,
  widgetCsatRequestSchema,
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
  it('needs text or an attachment for a message, and opens a conversation with or without text', () => {
    expect(widgetSendRequestSchema.safeParse({ clientId: CLIENT, text: ' ' }).success).toBe(false);
    expect(
      widgetSendRequestSchema.safeParse({ clientId: CLIENT, text: '', attachmentIds: [CLIENT] })
        .success,
    ).toBe(true);
    expect(widgetStartRequestSchema.parse({ clientId: CLIENT }).text).toBe('');
    expect(widgetStartRequestSchema.parse({ clientId: CLIENT, text: ' hi ' }).text).toBe('hi');
    expect(widgetStartRequestSchema.safeParse({ text: 'hi' }).success).toBe(false);
  });

  it('asks the config in a language the widget speaks', () => {
    expect(widgetConfigQuerySchema.parse({ locale: 'ar' })).toEqual({ locale: 'ar' });
    expect(widgetConfigQuerySchema.parse({})).toEqual({});
    expect(widgetConfigQuerySchema.safeParse({ locale: 'fr' }).success).toBe(false);
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
        WIDGET_EVENTS.csat,
      ].sort(),
    );
  });
});

describe('hours on a conversation (M7-06)', () => {
  const id = '0192c3f0-1a2b-7c3d-8e4f-0000000000aa';
  const stamp = '2026-09-25T17:40:00.000Z';
  const conversation = {
    id,
    reference: 'HD-1042',
    subject: 'Refund',
    state: 'open' as const,
    channel: 'chat' as const,
    lastSeq: 3,
    continuedById: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const hours = { open: false, nextOpenAt: '2026-09-27T05:00:00.000Z', timezone: 'Asia/Dubai' };

  it('accepts the hours on the conversation and on the conversation frame', () => {
    expect(widgetConversationSchema.parse({ ...conversation, hours }).hours).toEqual(hours);
    expect(
      widgetConversationEventSchema.parse({
        conversationId: id,
        state: 'open',
        continuedById: null,
        hours,
      }).hours,
    ).toEqual(hours);
  });

  it('accepts their absence, so a client built before this change still parses', () => {
    expect(widgetConversationSchema.parse(conversation).hours).toBeUndefined();
    expect(
      widgetConversationEventSchema.parse({
        conversationId: id,
        state: 'open',
        continuedById: null,
      }).hours,
    ).toBeUndefined();
  });

  it('keeps a null opening for a calendar that never opens, and refuses what is not a time', () => {
    expect(
      widgetConversationHoursSchema.parse({ ...hours, nextOpenAt: null }).nextOpenAt,
    ).toBeNull();
    expect(
      widgetConversationHoursSchema.safeParse({ ...hours, nextOpenAt: 'Monday' }).success,
    ).toBe(false);
  });

  it('carries no presence, which belongs to the brand', () => {
    expect(
      widgetConversationHoursSchema.parse({ ...hours, agentsOnline: true, agents: [] }),
    ).toEqual(hours);
  });
});

describe('widgetCsatRequestSchema', () => {
  it('trims the comment and caps it at the card’s 1000 characters', () => {
    expect(widgetCsatRequestSchema.parse({ rating: 4, comment: '  quick  ' })).toEqual({
      rating: 4,
      comment: 'quick',
    });
    expect(
      widgetCsatRequestSchema.safeParse({
        rating: 4,
        comment: 'x'.repeat(WIDGET_CSAT_COMMENT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('refuses a rating outside 1 to 5', () => {
    expect(widgetCsatRequestSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(widgetCsatRequestSchema.safeParse({ rating: 6 }).success).toBe(false);
  });
});
