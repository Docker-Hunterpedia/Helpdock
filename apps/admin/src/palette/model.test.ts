import { describe, expect, it } from 'vitest';
import {
  groupOptions,
  inListOrder,
  isolate,
  moveActive,
  namesTicket,
  rankLocal,
  recentAt,
  ticketReference,
} from './model.js';

const ticket = { prefix: 'HD', number: 1042 };

describe('namesTicket', () => {
  it.each(['HD-1042', 'hd-1042', ' HD-1042 ', 'HD1042', '#1042', '1042'])(
    'takes %j for HD-1042',
    (query) => {
      expect(namesTicket(query, ticket)).toBe(true);
    },
  );

  it.each(['104', '10420', 'HD-104', 'XX-1042', 'refund', '#10420', ''])(
    'does not take %j for HD-1042',
    (query) => {
      expect(namesTicket(query, ticket)).toBe(false);
    },
  );
});

describe('ticketReference', () => {
  it('joins the prefix and the number', () => {
    expect(ticketReference(ticket)).toBe('HD-1042');
  });
});

describe('rankLocal', () => {
  const entries = [
    { id: 'a', texts: ['Ticketing › Business hours'] },
    { id: 'b', texts: ['Hours report'] },
    { id: 'c', texts: ['Contacts'] },
  ];

  it('puts the better match first and keeps registry order between equals', () => {
    expect(rankLocal('hours', entries, (entry) => entry.texts).map((entry) => entry.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(rankLocal('zzz', entries, (entry) => entry.texts)).toEqual([]);
  });

  it('stops at the limit', () => {
    expect(rankLocal('o', entries, (entry) => entry.texts, 1)).toHaveLength(1);
  });
});

describe('groupOptions', () => {
  const options = [
    { id: 1, group: 'actions' as const },
    { id: 2, group: 'tickets' as const },
    { id: 3, group: 'pages' as const },
    { id: 4, group: 'tickets' as const },
  ];

  it('orders groups as the listbox shows them and drops empty ones', () => {
    expect(groupOptions(options).map(({ group }) => group)).toEqual([
      'tickets',
      'pages',
      'actions',
    ]);
  });

  it('lists options in the same order the groups draw them', () => {
    expect(inListOrder(options).map(({ id }) => id)).toEqual([2, 4, 3, 1]);
  });
});

describe('moveActive', () => {
  it('moves down and up, wrapping at the ends', () => {
    expect(moveActive(0, 'ArrowDown', 3)).toBe(1);
    expect(moveActive(2, 'ArrowDown', 3)).toBe(0);
    expect(moveActive(0, 'ArrowUp', 3)).toBe(2);
    expect(moveActive(2, 'ArrowUp', 3)).toBe(1);
  });

  it('starts at the first from nothing active', () => {
    expect(moveActive(-1, 'ArrowDown', 3)).toBe(0);
    expect(moveActive(-1, 'ArrowUp', 3)).toBe(2);
  });

  it('jumps with Home and End', () => {
    expect(moveActive(1, 'Home', 3)).toBe(0);
    expect(moveActive(1, 'End', 3)).toBe(2);
  });

  it('has nothing to move to in an empty list', () => {
    expect(moveActive(0, 'ArrowDown', 0)).toBe(-1);
  });
});

describe('isolate', () => {
  it('wraps text in first-strong isolates', () => {
    expect(isolate('HD-1042')).toBe('⁨HD-1042⁩');
  });
});

describe('recentAt', () => {
  it('remembers the ticket open in the workspace', () => {
    expect(recentAt('/tickets/abc')).toEqual({ kind: 'ticket', id: 'abc' });
  });

  it('remembers a contact’s page but not the screens beside it', () => {
    expect(recentAt('/contacts/abc')).toEqual({ kind: 'contact', id: 'abc' });
    expect(recentAt('/contacts/new')).toBeNull();
    expect(recentAt('/contacts/accounts')).toBeNull();
    expect(recentAt('/contacts')).toBeNull();
  });

  it('remembers a settings page by its registry id', () => {
    expect(recentAt('/settings/inbox/slas')).toEqual({ kind: 'page', id: 'ticketingSlas' });
  });

  it('does not remember the list, a primary page or a path nobody knows', () => {
    expect(recentAt('/tickets')).toBeNull();
    expect(recentAt('/reports')).toBeNull();
    expect(recentAt('/nowhere')).toBeNull();
  });
});
