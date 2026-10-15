import { describe, expect, it } from 'vitest';
import { importMessageSchema } from './import.js';

const message = {
  externalId: 'message',
  ticketExternalId: 'ticket',
  authorKind: 'customer',
  public: true,
  bodyText: 'Original message',
  createdAt: '2020-01-01T00:00:00Z',
  attachments: [],
};

describe('imported RFC Message-IDs', () => {
  it('preserves bracketed or bare original headers and permits records with no header', () => {
    for (const messageId of ['original@vendor', '<original@vendor>']) {
      expect(importMessageSchema.parse({ ...message, email: { messageId } }).email?.messageId).toBe(
        messageId,
      );
    }
    expect(importMessageSchema.parse(message).email).toBeUndefined();
  });
  it('rejects empty IDs, NULs, embedded header breaks and a trailing newline', () => {
    for (const messageId of [
      '',
      'original@vendor\r\nBcc: attacker@vendor',
      'original@vendor\n',
      'original\0@vendor',
    ]) {
      expect(importMessageSchema.safeParse({ ...message, email: { messageId } }).success).toBe(
        false,
      );
    }
  });
});
