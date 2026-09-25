import type { TicketList } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { testTicket } from './fixtures.js';
import { mergePages, moveSelection } from './pages.js';

const page = (ids: readonly string[], cursor: string | null = null): TicketList => ({
  tickets: ids.map((id) => testTicket({ id })),
  nextCursor: cursor,
});

describe('mergePages', () => {
  it('reads the pages in order', () => {
    const merged = mergePages([page(['a', 'b'], 'c:2'), page(['c'])]);

    expect(merged.map((ticket) => ticket.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the first sighting of a ticket that moved between pages', () => {
    // What a reply does to an `updated_at` ordering: the ticket rises to the
    // front, so page 2 hands back a row page 1 already showed.
    const merged = mergePages([page(['a', 'b'], 'c:2'), page(['b', 'c'])]);

    expect(merged.map((ticket) => ticket.id)).toEqual(['a', 'b', 'c']);
  });

  it('is empty before the first page has arrived', () => {
    expect(mergePages([])).toEqual([]);
  });
});

describe('moveSelection', () => {
  const tickets = ['a', 'b', 'c'].map((id) => testTicket({ id }));

  it('starts at the first row whichever direction is asked for', () => {
    expect(moveSelection(tickets, null, 1)).toBe('a');
    expect(moveSelection(tickets, null, -1)).toBe('a');
  });

  it('moves down and up', () => {
    expect(moveSelection(tickets, 'a', 1)).toBe('b');
    expect(moveSelection(tickets, 'b', -1)).toBe('a');
  });

  it('stops at the ends rather than wrapping', () => {
    expect(moveSelection(tickets, 'c', 1)).toBe('c');
    expect(moveSelection(tickets, 'a', -1)).toBe('a');
  });

  it('starts over when the selected ticket is no longer in the list', () => {
    expect(moveSelection(tickets, 'gone', 1)).toBe('a');
  });

  it('selects nothing when there is nothing', () => {
    expect(moveSelection([], null, 1)).toBeNull();
  });
});
