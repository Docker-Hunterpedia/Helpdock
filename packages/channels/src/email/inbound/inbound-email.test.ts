import { describe, expect, it } from 'vitest';
import {
  bareMessageId,
  headerValue,
  type InboundEmail,
  messageIdsIn,
  recipientsOf,
  synthesiseMessageId,
} from './inbound-email.js';

const email = (overrides: Partial<InboundEmail> = {}): InboundEmail => ({
  messageId: 'a@example.com',
  inReplyTo: null,
  references: [],
  from: { address: 'mona@example.com', name: 'Mona' },
  to: [{ address: 'support@helpdock.test', name: null }],
  cc: [],
  subject: 'Hello',
  date: null,
  html: null,
  text: 'Hi',
  headers: new Map(),
  attachments: [],
  ...overrides,
});

describe('message ids', () => {
  it('drops the angle brackets and any folding whitespace', () => {
    expect(bareMessageId('  <abc@host.example>\r\n')).toBe('abc@host.example');
  });

  it('reads every bracketed id of a References header in order', () => {
    expect(messageIdsIn('<one@a> <two@b>\r\n <three@c>')).toEqual(['one@a', 'two@b', 'three@c']);
  });

  it('falls back to whitespace-separated ids when a sender forgot the brackets', () => {
    expect(messageIdsIn('one@a two@b')).toEqual(['one@a', 'two@b']);
  });

  it('reads nothing from a missing header', () => {
    expect(messageIdsIn(null)).toEqual([]);
    expect(messageIdsIn(undefined)).toEqual([]);
  });
});

describe('synthesiseMessageId', () => {
  const parts = { from: 'mona@example.com', date: new Date(0), subject: 'Hi', body: 'Body' };

  it('is the same for the same message, so a redelivery dedupes', () => {
    expect(synthesiseMessageId(parts)).toBe(synthesiseMessageId({ ...parts }));
  });

  it('differs when the body differs, and lives under .invalid', () => {
    const id = synthesiseMessageId(parts);
    expect(id).not.toBe(synthesiseMessageId({ ...parts, body: 'Other' }));
    expect(id).toMatch(/@missing-message-id\.invalid$/);
  });
});

describe('recipientsOf', () => {
  it('puts the envelope first, then To and Cc, lower-cased and without repeats', () => {
    const message = email({
      to: [{ address: 'Support@Helpdock.test', name: null }],
      cc: [{ address: 'billing@helpdock.test', name: null }],
    });

    expect(recipientsOf(message, ['Hidden@Helpdock.test', 'support@helpdock.test'])).toEqual([
      'hidden@helpdock.test',
      'support@helpdock.test',
      'billing@helpdock.test',
    ]);
  });
});

describe('headerValue', () => {
  it('reads the first value case-insensitively', () => {
    const message = email({ headers: new Map([['precedence', ['bulk', 'list']]]) });
    expect(headerValue(message, 'Precedence')).toBe('bulk');
    expect(headerValue(message, 'auto-submitted')).toBeNull();
  });
});
