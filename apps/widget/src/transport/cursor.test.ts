import type { WidgetMessage, WidgetMessagePage } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { ConversationCursor } from './cursor.js';

const CONVERSATION = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const message = (seq: number): WidgetMessage => ({
  id: `0192c3f0-1a2b-7c3d-8e4f-${String(seq).padStart(12, '0')}`,
  conversationId: CONVERSATION,
  seq,
  clientId: null,
  author: 'agent',
  agent: null,
  text: `message ${String(seq)}`,
  html: null,
  attachments: [],
  createdAt: '2026-09-27T10:00:00.000Z',
});

const page = (seqs: number[], lastSeq: number, hasMore = false): WidgetMessagePage => ({
  messages: seqs.map(message),
  lastSeq,
  hasMore,
});

const cursorWith = (fetchAfter: (after: number) => Promise<WidgetMessagePage>, after = 3) => {
  const delivered: number[] = [];
  const cursor = new ConversationCursor({
    after,
    fetchAfter,
    deliver: (m) => delivered.push(m.seq),
  });
  return { cursor, delivered };
};

describe('ConversationCursor', () => {
  it('delivers the next message and drops one it already holds', () => {
    const fetchAfter = vi.fn();
    const { cursor, delivered } = cursorWith(fetchAfter);

    cursor.receive(message(4));
    cursor.receive(message(4));
    cursor.receive(message(2));

    expect(delivered).toEqual([4]);
    expect(cursor.last).toBe(4);
    expect(fetchAfter).not.toHaveBeenCalled();
  });

  it('catches up from its cursor on a gap, and moves past a seq it may not see', async () => {
    // seq 4 is an internal note; the visitor gets 5 and the page says 5.
    const fetchAfter = vi.fn(async () => page([5], 5));
    const { cursor, delivered } = cursorWith(fetchAfter);

    cursor.receive(message(5));
    await cursor.catchUp();

    expect(fetchAfter).toHaveBeenCalledWith(3);
    expect(delivered).toEqual([5]);
    expect(cursor.last).toBe(5);
  });

  it('pages until the server says there is no more', async () => {
    const fetchAfter = vi
      .fn()
      .mockResolvedValueOnce(page([4, 5], 5, true))
      .mockResolvedValueOnce(page([6], 8));
    const { cursor, delivered } = cursorWith(fetchAfter);

    await cursor.catchUp();

    expect(fetchAfter.mock.calls).toEqual([[3], [5]]);
    expect(delivered).toEqual([4, 5, 6]);
    expect(cursor.last).toBe(8);
  });

  it('runs one catch-up at a time and asks again for a gap found during it', async () => {
    let release: (value: WidgetMessagePage) => void = () => undefined;
    const fetchAfter = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<WidgetMessagePage>((resolve) => (release = resolve)),
      )
      .mockResolvedValueOnce(page([7], 7));
    const { cursor, delivered } = cursorWith(fetchAfter);

    const first = cursor.catchUp();
    cursor.receive(message(7));
    release(page([4, 5, 6], 6));
    await first;
    await vi.waitFor(() => expect(delivered).toEqual([4, 5, 6, 7]));

    expect(fetchAfter).toHaveBeenCalledTimes(2);
  });

  it('reports a failed catch-up and keeps its place', async () => {
    const onError = vi.fn();
    const cursor = new ConversationCursor({
      after: 3,
      fetchAfter: () => Promise.reject(new Error('offline')),
      deliver: () => undefined,
      onError,
    });

    await cursor.catchUp();

    expect(onError).toHaveBeenCalledOnce();
    expect(cursor.last).toBe(3);
  });
});
