import { describe, expect, it } from 'vitest';
import { referencedTickets } from './referenced-tickets.js';

describe('historical email references', () => {
  it('normalizes bare/bracketed headers while retaining one unambiguous historical ticket', () => {
    expect(
      referencedTickets(
        [],
        [{ ticketId: 'one', externalId: '<original@vendor>', importSourceAccountKey: 'account' }],
      ).tickets.get('original@vendor'),
    ).toBe('one');
  });
  it('refuses ambiguous history regardless of row order', () => {
    const rows = ['one', 'two'].map((ticketId) => ({
      ticketId,
      externalId: 'shared@vendor',
      importSourceAccountKey: ticketId,
    }));
    expect(referencedTickets([], rows).ambiguous.has('shared@vendor')).toBe(true);
    expect(referencedTickets([], [...rows].reverse()).ambiguous.has('shared@vendor')).toBe(true);
  });
  it('keeps repeated rows of the same ticket unambiguous', () => {
    const row = { ticketId: 'one', externalId: 'shared@vendor', importSourceAccountKey: 'account' };
    expect(referencedTickets([], [row, row]).tickets.get('shared@vendor')).toBe('one');
  });
  it('prefers real sent mail and then live received mail over conflicting history', () => {
    const history = {
      ticketId: 'historical',
      externalId: 'same@vendor',
      importSourceAccountKey: 'account',
    };
    const live = { ticketId: 'live', externalId: 'same@vendor', importSourceAccountKey: null };
    expect(referencedTickets([], [history, live]).tickets.get('same@vendor')).toBe('live');
    expect(
      referencedTickets(
        [{ ticketId: 'sent', messageId: '<same@vendor>' }],
        [history, live],
      ).tickets.get('same@vendor'),
    ).toBe('sent');
  });
  it('ignores missing headers and refuses conflicting authoritative deliveries', () => {
    expect(
      referencedTickets([], [{ ticketId: 'one', externalId: null, importSourceAccountKey: null }])
        .tickets.size,
    ).toBe(0);
    expect(
      referencedTickets(
        [
          { ticketId: 'one', messageId: '<same@vendor>' },
          { ticketId: 'two', messageId: '<same@vendor>' },
        ],
        [],
      ).tickets.size,
    ).toBe(0);
  });
});
