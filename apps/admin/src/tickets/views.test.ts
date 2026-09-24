import { describe, expect, it } from 'vitest';
import { HOUR, NOW, testStatus, testTicket } from './fixtures.js';
import { applyView, isOverdue, TICKET_VIEWS, viewByKey, viewCount } from './views.js';

const ME = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';
const past = new Date(NOW - 2 * HOUR).toISOString();
const future = new Date(NOW + 2 * HOUR).toISOString();

describe('the default views', () => {
  it('asks the api for what the api can answer', () => {
    expect(TICKET_VIEWS.myOpen.query(ME)).toEqual({
      assigneeId: [ME],
      systemState: ['open', 'on_hold', 'escalated'],
    });
    expect(TICKET_VIEWS.unassigned.query(ME).assigneeId).toEqual(['unassigned']);
    expect(TICKET_VIEWS.escalated.query(ME)).toEqual({ systemState: ['escalated'] });
  });

  it('is the only one of the four that needs a predicate', () => {
    expect(TICKET_VIEWS.overdue.predicate).toBeDefined();
    expect(TICKET_VIEWS.myOpen.predicate).toBeUndefined();
  });

  it('answers to its key, and to nothing else', () => {
    expect(viewByKey('overdue')).toBe(TICKET_VIEWS.overdue);
    expect(viewByKey('all')).toBeNull();
    expect(viewByKey(null)).toBeNull();
  });
});

describe('isOverdue', () => {
  it('counts a first-response clock that has run out', () => {
    expect(isOverdue(testTicket({ firstResponseDueAt: past }), NOW)).toBe(true);
  });

  it('counts a resolution clock that has run out', () => {
    expect(isOverdue(testTicket({ resolutionDueAt: past }), NOW)).toBe(true);
  });

  it('counts a ticket the api has already marked breached', () => {
    expect(isOverdue(testTicket({ slaBreached: true }), NOW)).toBe(true);
  });

  it('does not count a clock that is still running', () => {
    expect(isOverdue(testTicket({ resolutionDueAt: future }), NOW)).toBe(false);
  });

  it('does not count a paused clock: waiting is not late', () => {
    const awaiting = testTicket({
      status: testStatus({ systemState: 'on_hold', pausesSla: true }),
      firstResponseDueAt: past,
    });

    expect(isOverdue(awaiting, NOW)).toBe(false);
  });

  it('does not count a closed ticket, whose clocks nobody can act on', () => {
    const closed = testTicket({
      status: testStatus({ systemState: 'closed' }),
      resolutionDueAt: past,
      slaBreached: true,
    });

    expect(isOverdue(closed, NOW)).toBe(false);
  });

  it('does not count a ticket no policy covers', () => {
    expect(isOverdue(testTicket(), NOW)).toBe(false);
  });
});

describe('applyView', () => {
  const rows = [
    testTicket({ id: 'late', resolutionDueAt: past }),
    testTicket({ id: 'fine', resolutionDueAt: future }),
  ];

  it('narrows to what the predicate keeps', () => {
    expect(applyView(TICKET_VIEWS.overdue, rows, NOW).map((row) => row.id)).toEqual(['late']);
  });

  it('keeps every row when the query was the whole view', () => {
    expect(applyView(TICKET_VIEWS.myOpen, rows, NOW)).toEqual(rows);
  });

  it('keeps every row when no view is selected at all', () => {
    expect(applyView(null, rows, NOW)).toEqual(rows);
  });
});

describe('viewCount', () => {
  it('counts what the view actually shows', () => {
    const list = {
      tickets: [testTicket({ id: 'late', resolutionDueAt: past }), testTicket({ id: 'fine' })],
      nextCursor: null,
    };

    expect(viewCount(TICKET_VIEWS.overdue, list, NOW)).toEqual({ count: 1, partial: false });
  });

  it('says the count is a floor while the api has more pages', () => {
    const list = { tickets: [testTicket()], nextCursor: 'c:1' };

    expect(viewCount(TICKET_VIEWS.myOpen, list, NOW)).toEqual({ count: 1, partial: true });
  });
});
