import type { TicketMessage } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  canReplyToMessage,
  NO_REPLY_TARGET,
  quotePreview,
  recipientsNote,
  replyTargetReducer,
} from './reply-target.js';

describe('replyTargetReducer', () => {
  it('points at a message and moves to another', () => {
    const first = replyTargetReducer(NO_REPLY_TARGET, { type: 'point', messageId: 'a' });
    const moved = replyTargetReducer(first, { type: 'point', messageId: 'b' });

    expect(first).toEqual({ messageId: 'a', unavailable: false });
    expect(moved).toEqual({ messageId: 'b', unavailable: false });
  });

  it('keeps the same state when the same message is pressed again', () => {
    const state = replyTargetReducer(NO_REPLY_TARGET, { type: 'point', messageId: 'a' });

    expect(replyTargetReducer(state, { type: 'point', messageId: 'a' })).toBe(state);
  });

  it('clears, and clearing nothing changes nothing', () => {
    const state = replyTargetReducer(NO_REPLY_TARGET, { type: 'point', messageId: 'a' });

    expect(replyTargetReducer(state, { type: 'clear' })).toBe(NO_REPLY_TARGET);
    expect(replyTargetReducer(NO_REPLY_TARGET, { type: 'clear' })).toBe(NO_REPLY_TARGET);
  });

  it('marks a refused target unavailable until the agent moves or clears it', () => {
    const gone = replyTargetReducer(NO_REPLY_TARGET, { type: 'gone', messageId: 'a' });

    expect(gone).toEqual({ messageId: 'a', unavailable: true });
    expect(replyTargetReducer(gone, { type: 'point', messageId: 'b' })).toEqual({
      messageId: 'b',
      unavailable: false,
    });
    expect(replyTargetReducer(gone, { type: 'clear' })).toBe(NO_REPLY_TARGET);
  });
});

describe('canReplyToMessage', () => {
  const message = (values: Partial<TicketMessage>): TicketMessage =>
    ({ kind: 'public', authorType: 'contact', channel: 'email', ...values }) as TicketMessage;

  it('allows a public customer email', () => {
    expect(canReplyToMessage(message({}))).toBe(true);
  });

  it.each([
    ['a note', { kind: 'note' as const }],
    ['a staff reply', { authorType: 'staff' as const }],
    ['a system event', { kind: 'system' as const, authorType: 'system' as const }],
    ['a chat message', { channel: 'chat' as const }],
    ['a Telegram message', { channel: 'telegram' as const }],
  ])('refuses %s', (_name, values) => {
    expect(canReplyToMessage(message(values))).toBe(false);
  });
});

describe('recipientsNote', () => {
  const target = (address: string) =>
    ({ email: { from: { address, name: 'Mona Khalil' } } }) as unknown as TicketMessage;
  const email = (address: string, ccs = 0) => ({
    to: { name: 'Karim Nasser', address },
    ccs: Array.from({ length: ccs }, () => ({})),
  });

  it('is null when the sender is the address the reply goes to, whatever its case', () => {
    expect(
      recipientsNote(target('Mona@Example.com'), 'Mona', email('mona@example.com', 2)),
    ).toBeNull();
  });

  it('names the sender, the To and the number of copies when they differ', () => {
    expect(recipientsNote(target('mona@example.com'), 'Mona', email('karim@acme.test', 2))).toEqual(
      {
        name: 'Mona',
        to: 'Karim Nasser',
        ccCount: 2,
      },
    );
  });

  it('says nothing when either address is unknown', () => {
    expect(recipientsNote(undefined, 'Mona', email('karim@acme.test'))).toBeNull();
    expect(recipientsNote(target('mona@example.com'), 'Mona', { to: null, ccs: [] })).toBeNull();
    expect(recipientsNote(target(''), 'Mona', email('karim@acme.test'))).toBeNull();
  });
});

describe('quotePreview', () => {
  it('cuts at 2,000 code points and marks the cut, as the mail does', () => {
    const cut = quotePreview('😀'.repeat(2001));

    expect(Array.from(cut)).toHaveLength(2001);
    expect(cut.endsWith('😀…')).toBe(true);
  });

  it('leaves short text alone, with line endings normalised', () => {
    expect(quotePreview('a\r\nb')).toBe('a\nb');
  });
});
