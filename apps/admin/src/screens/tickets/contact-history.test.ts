import type { ContactTimelineItem } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { previousTicketDate, previousTickets } from './contact-history.js';

const STATUS_ID = '0192c3f0-1a2b-7c3d-8e4f-000000000050';

const item = (id: string, createdAt: string): ContactTimelineItem => ({
  id,
  reference: `HD-${id}`,
  subject: `Ticket ${id}`,
  status: 'Open',
  statusId: STATUS_ID,
  channel: 'email',
  departmentName: 'Support',
  assigneeName: null,
  createdAt,
});

const OPEN = item('1042', '2026-10-15T09:00:00.000Z');
const SEPT = item('1031', '2026-09-12T09:00:00.000Z');
const AUG = item('0988', '2026-08-02T09:00:00.000Z');
const JUNE = item('0912', '2026-06-14T09:00:00.000Z');
const MAY = item('0870', '2026-05-01T09:00:00.000Z');

describe('previousTickets', () => {
  it('leaves the open ticket out and counts the rest', () => {
    const history = previousTickets(
      { items: [OPEN, SEPT], visibleCount: 2, hiddenCount: 0 },
      OPEN.id,
    );

    expect(history.shown).toEqual([SEPT]);
    expect(history.count).toBe(1);
  });

  it('lists the three most recent, newest first, whatever order they arrive in', () => {
    const history = previousTickets(
      { items: [MAY, AUG, OPEN, JUNE, SEPT], visibleCount: 5, hiddenCount: 0 },
      OPEN.id,
    );

    expect(history.shown.map((row) => row.id)).toEqual([SEPT.id, AUG.id, JUNE.id]);
    expect(history.count).toBe(4);
  });

  it('counts past the page the timeline stops at', () => {
    // The api lists the newest 50 and counts them all; the open ticket is one
    // of the visible ones even when it is older than the page.
    const history = previousTickets(
      { items: [SEPT, AUG, JUNE], visibleCount: 80, hiddenCount: 0 },
      OPEN.id,
    );

    expect(history.count).toBe(79);
  });

  it('is empty for a first ticket, and passes the hidden count through', () => {
    const history = previousTickets({ items: [OPEN], visibleCount: 1, hiddenCount: 2 }, OPEN.id);

    expect(history).toEqual({ shown: [], count: 0, hiddenCount: 2 });
  });
});

describe('previousTicketDate', () => {
  const now = Date.parse('2026-10-19T12:00:00.000Z');

  it('leaves the year out for this year', () => {
    expect(previousTicketDate(OPEN.createdAt, 'en', now)).toBe('15 Oct');
  });

  it('says the year for an earlier one, with Latin digits in Arabic', () => {
    expect(previousTicketDate('2025-10-12T09:00:00.000Z', 'en', now)).toBe('12 Oct 2025');
    expect(previousTicketDate('2025-10-12T09:00:00.000Z', 'ar', now)).toMatch(/^12 .+ 2025$/);
  });
});
