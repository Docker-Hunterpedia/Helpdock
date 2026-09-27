import { describe, expect, it } from 'vitest';
import type { WidgetMessage } from '../transport/types.js';
import {
  addPending,
  applyCatchUp,
  applyLive,
  applyReadReceipt,
  deliveryOf,
  emptyThread,
  type PendingMessage,
  setPendingStatus,
  type ThreadState,
} from './thread.js';

const message = (seq: number, clientId: string | null = null): WidgetMessage => ({
  id: `m${seq}`,
  conversation_id: 'c1',
  seq,
  client_id: clientId,
  author: clientId ? { kind: 'visitor' } : { kind: 'system' },
  body: `message ${seq}`,
  attachments: [],
  system: null,
  created_at: '2026-09-27T09:00:00Z',
});

const pending = (clientId: string): PendingMessage => ({
  client_id: clientId,
  body: 'hello',
  attachments: [],
  status: 'sending',
  created_at: '2026-09-27T09:00:00Z',
});

const seqs = (state: ThreadState) => state.confirmed.map((entry) => entry.seq);

describe('applyLive', () => {
  it('advances the cursor for the next seq in order', () => {
    const one = applyLive(emptyThread, message(1));
    const two = applyLive(one.state, message(2));

    expect(two.state.lastSeq).toBe(2);
    expect(two.gap).toBe(false);
    expect(seqs(two.state)).toEqual([1, 2]);
  });

  it('keeps a message that skips ahead but reports a gap and holds the cursor', () => {
    const result = applyLive(applyLive(emptyThread, message(1)).state, message(3));

    expect(result.gap).toBe(true);
    expect(result.state.lastSeq).toBe(1);
    expect(seqs(result.state)).toEqual([1, 3]);
  });

  it('ignores a seq it already holds, so a socket echo of a send is harmless', () => {
    const first = applyLive(emptyThread, message(1, 'c-1'));
    const echo = applyLive(first.state, message(1, 'c-1'));

    expect(echo.added).toEqual([]);
    expect(echo.state.confirmed).toHaveLength(1);
  });

  it('replaces the pending entry with the same client_id once the message holds a seq', () => {
    const queued = addPending(addPending(emptyThread, pending('c-1')), pending('c-2'));
    const result = applyLive(queued, message(1, 'c-1'));

    expect(result.state.pending.map((entry) => entry.client_id)).toEqual(['c-2']);
    expect(seqs(result.state)).toEqual([1]);
  });
});

describe('applyCatchUp', () => {
  it('fills the gap, sorts by seq and moves the cursor to the highest seq returned', () => {
    const withGap = applyLive(applyLive(emptyThread, message(1)).state, message(4)).state;
    const result = applyCatchUp(withGap, [message(2), message(3), message(4)]);

    expect(seqs(result.state)).toEqual([1, 2, 3, 4]);
    expect(result.state.lastSeq).toBe(4);
    expect(result.added.map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it('trusts the answer over missing seqs, so hidden internal notes cannot loop the catch-up', () => {
    const result = applyCatchUp(emptyThread, [message(1), message(5)]);

    expect(result.state.lastSeq).toBe(5);
    expect(applyLive(result.state, message(6)).gap).toBe(false);
  });

  it('keeps the cursor when the answer is empty', () => {
    const state = applyLive(emptyThread, message(1)).state;

    expect(applyCatchUp(state, []).state.lastSeq).toBe(1);
  });
});

describe('pending entries', () => {
  it('adds a client_id once, however often the visitor presses send', () => {
    const state = addPending(addPending(emptyThread, pending('c-1')), pending('c-1'));

    expect(state.pending).toHaveLength(1);
  });

  it('moves one entry between sending and failed', () => {
    const state = addPending(addPending(emptyThread, pending('c-1')), pending('c-2'));
    const failed = setPendingStatus(state, 'c-2', 'failed');

    expect(failed.pending.map((entry) => entry.status)).toEqual(['sending', 'failed']);
  });
});

describe('read receipts', () => {
  it('marks messages up to the receipt seen and never moves backwards', () => {
    const state = applyCatchUp(emptyThread, [message(1, 'a'), message(2, 'b')]).state;
    const read = applyReadReceipt(applyReadReceipt(state, 1), 0);

    expect(read.readSeq).toBe(1);
    expect(deliveryOf(read, message(1, 'a'))).toBe('seen');
    expect(deliveryOf(read, message(2, 'b'))).toBe('sent');
  });
});
