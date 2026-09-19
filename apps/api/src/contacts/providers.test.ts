import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  type ContactTimelineProvider,
  EMPTY_CONTACT_STATS,
  NoContactTimelineProvider,
  NoTicketStatsProvider,
  type TicketStatsProvider,
} from './providers.js';

/**
 * The seam M1-02 replaces. What matters about the null implementations is that
 * they answer "none yet" rather than "none" — `withOpenTickets` returns null so
 * the filter narrows nothing, instead of an empty list that would hide every
 * row and look like a broken screen.
 */

// biome-ignore lint/suspicious/noExplicitAny: the null providers ignore the transaction; a real one would need a database.
const tx = {} as any as DbTransaction;
const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

describe('NoTicketStatsProvider', () => {
  it('knows nothing about any contact', async () => {
    const provider: TicketStatsProvider = new NoTicketStatsProvider();
    const stats = await provider.forContacts(tx, BRAND, ['a', 'b']);

    expect(stats.size).toBe(0);
  });

  it('answers null to the open-ticket filter rather than an empty list', async () => {
    const provider: TicketStatsProvider = new NoTicketStatsProvider();
    const allowed = await provider.withOpenTickets(tx, BRAND, ['a']);

    expect(allowed).toBeNull();
  });
});

describe('NoContactTimelineProvider', () => {
  it('shows no tickets and hides none', async () => {
    const provider: ContactTimelineProvider = new NoContactTimelineProvider();
    const timeline = await provider.forContact(tx, BRAND, 'a');

    expect(timeline).toEqual({ items: [], hiddenCount: 0 });
  });
});

describe('EMPTY_CONTACT_STATS', () => {
  it('is zeroes and nulls, which is what a contact with no tickets looks like', () => {
    expect(EMPTY_CONTACT_STATS).toEqual({
      openTickets: 0,
      totalTickets: 0,
      csat: null,
      averageFirstReplySeconds: null,
      lastTicketAt: null,
    });
  });

  it('is frozen, so a caller cannot mutate the shared default', () => {
    expect(Object.isFrozen(EMPTY_CONTACT_STATS)).toBe(true);
  });
});
