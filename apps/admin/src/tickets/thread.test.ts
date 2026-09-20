import type { TicketActivityEntry } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { testMessage } from './fixtures.js';
import type { PendingMessage } from './pending.js';
import { applyCatchUp, buildThread, lastSeq } from './thread.js';

const entry = (
  overrides: Partial<TicketActivityEntry> & Pick<TicketActivityEntry, 'id' | 'action'>,
): TicketActivityEntry => ({
  ticketId: '0192c3f0-1a2b-7c3d-8e4f-000000001042',
  actorType: 'staff',
  actorId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
  from: null,
  to: null,
  via: 'ui',
  createdAt: '2026-09-19T11:00:00.000Z',
  ...overrides,
});

const pending: PendingMessage = {
  clientId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
  kind: 'public',
  bodyHtml: '<p>On its way.</p>',
  bodyText: 'On its way.',
  createdAt: '2026-09-19T11:00:00.000Z',
  sentAt: 0,
  state: 'sending',
};

describe('buildThread', () => {
  it('orders everything by time', () => {
    const items = buildThread(
      [
        testMessage({ seq: 2, createdAt: '2026-09-19T11:30:00.000Z' }),
        testMessage({ seq: 1, createdAt: '2026-09-19T10:00:00.000Z' }),
      ],
      [entry({ id: 'a1', action: 'ticket.updated', createdAt: '2026-09-19T11:00:00.000Z' })],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(['message', 'event', 'message']);
  });

  it('draws only the activity that no bubble already says', () => {
    const items = buildThread(
      [],
      [
        entry({ id: 'a1', action: 'ticket.created' }),
        entry({ id: 'a2', action: 'ticket.replied' }),
        entry({ id: 'a3', action: 'ticket.note_added' }),
        entry({ id: 'a4', action: 'ticket.updated' }),
        entry({ id: 'a5', action: 'ticket.status.changed' }),
      ],
      [],
    );

    expect(items.map((item) => item.id)).toEqual(['a4', 'a5']);
  });

  it('puts a send that has not landed at the end of its own instant', () => {
    const items = buildThread(
      [testMessage({ seq: 1, createdAt: '2026-09-19T11:00:00.000Z' })],
      [entry({ id: 'a1', action: 'ticket.updated' })],
      [pending],
    );

    expect(items.map((item) => item.kind)).toEqual(['event', 'message', 'pending']);
  });

  it('keys a pending item by its clientId, which is what a retry keeps', () => {
    const [item] = buildThread([], [], [pending]);

    expect(item?.id).toBe(pending.clientId);
  });
});

describe('lastSeq', () => {
  it('is the highest seq held, which is what a catch-up asks after', () => {
    expect(lastSeq([testMessage({ seq: 3 }), testMessage({ seq: 7 })])).toBe(7);
  });

  it('is zero on an empty thread, so the first read asks for everything', () => {
    expect(lastSeq([])).toBe(0);
  });
});

describe('applyCatchUp', () => {
  it('appends what arrived, in seq order', () => {
    const merged = applyCatchUp([testMessage({ seq: 1 })], [testMessage({ seq: 3 })]);

    expect(merged.map((message) => message.seq)).toEqual([1, 3]);
  });

  it('replaces a message already held rather than drawing it twice', () => {
    const merged = applyCatchUp(
      [testMessage({ seq: 1, bodyText: 'old' })],
      [testMessage({ seq: 1, bodyText: 'new' })],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.bodyText).toBe('new');
  });

  it('sorts by the server’s ordering, not by arrival', () => {
    const merged = applyCatchUp(
      [testMessage({ seq: 5 })],
      [testMessage({ seq: 4 }), testMessage({ seq: 2 })],
    );

    expect(merged.map((message) => message.seq)).toEqual([2, 4, 5]);
  });
});
