import { describe, expect, it } from 'vitest';
import { redactWebhookNotes } from './webhook-note-redaction.js';

const note = {
  event: 'message.created',
  brandId: 'brand',
  departmentId: 'department',
  data: {
    message: {
      id: 'message',
      public: false,
      authorType: 'staff',
      bodyHtml: '<p>Private</p>',
      bodyText: 'Private',
    },
  },
};

describe('per-endpoint internal note disclosure', () => {
  it('removes both bodies by default without changing the source or losing metadata', () => {
    const redacted = redactWebhookNotes(note, false);
    expect(redacted).toEqual({
      ...note,
      data: { message: { id: 'message', public: false, authorType: 'staff' } },
    });
    expect(JSON.stringify(redacted)).not.toContain('Private');
    expect(note.data.message.bodyText).toBe('Private');
  });
  it('preserves bodies for an opted-in endpoint', () => {
    expect(redactWebhookNotes(note, true)).toEqual(note);
  });
  it('preserves public replies and unrelated events', () => {
    const reply = { ...note, data: { message: { ...note.data.message, public: true } } };
    expect(redactWebhookNotes(reply, false)).toEqual(reply);
    expect(redactWebhookNotes({ event: 'ping' }, false)).toEqual({ event: 'ping' });
  });
});
