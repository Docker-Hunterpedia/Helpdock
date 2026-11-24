import type { TicketMessage } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { canReplyToMessage, NO_REPLY_TARGET, replyTargetReducer } from './reply-target.js';

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
