import { describe, expect, it } from 'vitest';
import { HOUR, NOW, testStatus, testTicket } from '../../tickets/fixtures.js';
import {
  elapsed,
  elapsedFraction,
  messageTime,
  PRIORITY_TONE,
  paragraph,
  shortDuration,
  slaState,
  statusName,
  ticketReference,
} from './format.js';

const iso = (offset: number): string => new Date(NOW + offset).toISOString();

describe('ticketReference', () => {
  it('is what a person reads, prefix and all', () => {
    expect(ticketReference({ prefix: 'HD', number: 1042 })).toBe('HD-1042');
  });
});

describe('shortDuration', () => {
  it('rounds down to the largest unit that fits', () => {
    expect(shortDuration(12 * 60 * 1000)).toBe('12m');
    expect(shortDuration(4 * HOUR)).toBe('4h');
    expect(shortDuration(3 * 24 * HOUR)).toBe('3d');
  });

  it('says "now" under a minute rather than measuring nothing', () => {
    expect(shortDuration(5_000)).toBe('now');
  });

  it('reads the same in both directions: the sign is the caller’s to say', () => {
    expect(shortDuration(-4 * HOUR)).toBe('4h');
  });
});

describe('elapsed', () => {
  it('is how long ago a row last moved', () => {
    expect(elapsed(iso(-2 * HOUR), NOW)).toBe('2h');
  });
});

describe('PRIORITY_TONE', () => {
  it('maps the four priorities onto the hues DESIGN §6.2 allows', () => {
    expect(PRIORITY_TONE).toEqual({
      urgent: 'danger',
      high: 'warning',
      medium: 'info',
      low: 'neutral',
    });
  });
});

describe('slaState', () => {
  it('has nothing to draw when no policy covers the ticket', () => {
    expect(slaState(testTicket(), NOW)).toEqual({ kind: 'none' });
  });

  it('has nothing to draw on a closed ticket, whose clock nobody can act on', () => {
    const closed = testTicket({
      status: testStatus({ systemState: 'closed' }),
      firstResponseDueAt: iso(-HOUR),
    });

    expect(slaState(closed, NOW)).toEqual({ kind: 'none' });
  });

  it('is paused in a status that pauses the clock', () => {
    const awaiting = testTicket({
      status: testStatus({ systemState: 'on_hold', pausesSla: true }),
      firstResponseDueAt: iso(HOUR),
    });

    expect(slaState(awaiting, NOW)).toEqual({ kind: 'paused' });
  });

  it('is breached once the due date has passed, and says by how much', () => {
    const late = testTicket({
      createdAt: iso(-6 * HOUR),
      firstResponseDueAt: iso(-2 * HOUR),
    });

    expect(slaState(late, NOW)).toEqual({ kind: 'breached', over: '2h' });
  });

  it('is breached when the api says so, whatever the dates read', () => {
    const flagged = testTicket({ resolutionDueAt: iso(HOUR), slaBreached: true });

    expect(slaState(flagged, NOW).kind).toBe('breached');
  });

  it('is running while more than a fifth of the window is left', () => {
    const running = testTicket({ createdAt: iso(-HOUR), firstResponseDueAt: iso(3 * HOUR) });

    expect(slaState(running, NOW)).toEqual({ kind: 'running', remaining: '3h' });
  });

  it('is at risk under a fifth of the window (DESIGN §6.2)', () => {
    const atRisk = testTicket({
      createdAt: iso(-10 * HOUR),
      firstResponseDueAt: iso(HOUR),
    });

    expect(slaState(atRisk, NOW).kind).toBe('atRisk');
  });

  it('reads the first-response clock before the resolution clock', () => {
    const both = testTicket({
      createdAt: iso(-HOUR),
      firstResponseDueAt: iso(-30 * 60 * 1000),
      resolutionDueAt: iso(10 * HOUR),
    });

    expect(slaState(both, NOW).kind).toBe('breached');
  });
});

describe('messageTime', () => {
  it('names the weekday while the message is recent', () => {
    expect(messageTime(iso(-2 * HOUR), 'en', NOW)).toMatch(/^\w{3},? \d{2}:\d{2}$/u);
  });

  it('names the date once a weekday has stopped meaning anything', () => {
    expect(messageTime(iso(-20 * 24 * HOUR), 'en', NOW)).toMatch(/\d/u);
  });

  it('uses Latin digits in Arabic (DESIGN §7)', () => {
    const arabic = messageTime(iso(-2 * HOUR), 'ar', NOW);

    expect(arabic).toMatch(/[0-9]/u);
    expect(arabic).not.toMatch(/[٠-٩]/u);
  });
});

describe('statusName', () => {
  it('prints the brand’s own name for the locale being read', () => {
    expect(statusName(testStatus(), 'en')).toBe('Open');
    expect(statusName(testStatus(), 'ar')).toBe('مفتوحة');
  });

  it('falls back to the English name when a brand has not translated one', () => {
    expect(statusName(testStatus({ nameAr: null }), 'ar')).toBe('Open');
  });
});

describe('paragraph', () => {
  it('escapes what a person typed rather than trusting the sanitiser', () => {
    expect(paragraph('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('keeps the line breaks somebody typed', () => {
    expect(paragraph('one\ntwo')).toBe('<p>one<br />two</p>');
  });

  it('escapes an ampersand before anything else, so nothing double-encodes', () => {
    expect(paragraph('a & b')).toBe('<p>a &amp; b</p>');
  });
});

describe('elapsedFraction', () => {
  it('is how much of the window has gone', () => {
    expect(elapsedFraction(iso(-2 * HOUR), iso(2 * HOUR), NOW)).toBe(0.5);
  });

  it('never runs past the track', () => {
    expect(elapsedFraction(iso(-10 * HOUR), iso(-2 * HOUR), NOW)).toBe(1);
    expect(elapsedFraction(iso(HOUR), iso(2 * HOUR), NOW)).toBe(0);
  });

  it('is full when the window is not a window at all', () => {
    expect(elapsedFraction(iso(0), iso(0), NOW)).toBe(1);
  });
});
