import { describe, expect, it } from 'vitest';
import { conversationAccess } from './conversation-access.js';

const VISITOR = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
const OTHER_VISITOR = '0192c3f0-1a2b-7c3d-8e4f-0000000000a2';
const CONTACT = '0192c3f0-1a2b-7c3d-8e4f-0000000000c1';
const OTHER_CONTACT = '0192c3f0-1a2b-7c3d-8e4f-0000000000c2';

const ticket = (overrides: Partial<Parameters<typeof conversationAccess>[0]> = {}) => ({
  visitorId: null,
  contactId: CONTACT,
  channel: 'chat' as const,
  deletedAt: null,
  ...overrides,
});

const anonymous = { id: VISITOR, verifiedContactId: null };
const verified = { id: VISITOR, verifiedContactId: CONTACT };
const NARROW = { seesAllChannels: false };
const WIDE = { seesAllChannels: true };

describe('conversationAccess (DOMAIN-RULES §4.1–4.2)', () => {
  it('lets a visitor write the conversations they opened, and nothing else', () => {
    expect(conversationAccess(ticket({ visitorId: VISITOR }), anonymous, NARROW)).toBe('write');
    expect(conversationAccess(ticket({ visitorId: OTHER_VISITOR }), anonymous, WIDE)).toBe('none');
    expect(conversationAccess(ticket(), anonymous, WIDE)).toBe('none');
  });

  it('gives a verified visitor the contact’s widget conversations, and other channels only when allowed', () => {
    expect(conversationAccess(ticket({ visitorId: OTHER_VISITOR }), verified, NARROW)).toBe(
      'write',
    );
    expect(conversationAccess(ticket({ channel: 'email' }), verified, NARROW)).toBe('none');
    expect(conversationAccess(ticket({ channel: 'email' }), verified, WIDE)).toBe('read');
    expect(conversationAccess(ticket({ contactId: OTHER_CONTACT }), verified, WIDE)).toBe('none');
  });

  it('hides a deleted ticket from everybody', () => {
    expect(
      conversationAccess(ticket({ visitorId: VISITOR, deletedAt: new Date() }), anonymous, WIDE),
    ).toBe('none');
  });
});
