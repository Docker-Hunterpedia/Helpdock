import type { NotificationPreferencesView } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  emailStatuses,
  hourLabel,
  pauseDateBounds,
  pauseDateEnd,
  pausePresets,
  whenLabel,
} from './email-status.js';

const NOW = new Date('2026-10-21T14:12:00Z');

const view = (
  delivery: Partial<NotificationPreferencesView['emailDelivery']> = {},
  emailConfigured = true,
): Pick<NotificationPreferencesView, 'emailDelivery' | 'emailConfigured'> => ({
  emailDelivery: {
    schedule: 'immediate',
    digestHour: 8,
    pausedUntil: null,
    unsubscribedAt: null,
    ...delivery,
  },
  emailConfigured,
});

describe('emailStatuses', () => {
  it('has nothing to say when email is flowing', () => {
    expect(emailStatuses(view(), NOW.getTime())).toEqual([]);
  });

  it('lists the lasting reasons first: unsubscribed, then paused, then Off, then no SMTP', () => {
    const all = view(
      {
        unsubscribedAt: '2026-10-03T08:00:00.000Z',
        pausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
        schedule: 'off',
      },
      false,
    );

    expect(emailStatuses(all, NOW.getTime())).toEqual([
      'unsubscribed',
      'paused',
      'off',
      'notConfigured',
    ]);
  });

  it('does not call a pause that already ended a pause', () => {
    const ended = view({ pausedUntil: new Date(NOW.getTime() - 1000).toISOString() });

    expect(emailStatuses(ended, NOW.getTime())).toEqual([]);
  });
});

const RIYADH = 'Asia/Riyadh';
const LOS_ANGELES = 'America/Los_Angeles';
const AUCKLAND = 'Pacific/Auckland';

describe('pausePresets', () => {
  it('is an hour from now, 09:00 tomorrow in the zone, and a week from now', () => {
    const { hour, tomorrow, week } = pausePresets(NOW, RIYADH);

    expect(hour.getTime() - NOW.getTime()).toBe(3_600_000);
    expect(tomorrow.toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(week.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
  });

  it.each([
    [LOS_ANGELES, '2026-10-22T16:00:00.000Z'],
    [AUCKLAND, '2026-10-22T20:00:00.000Z'],
  ])('reads "tomorrow" on the calendar of %s, not the browser’s', (zone, expected) => {
    expect(pausePresets(NOW, zone).tomorrow.toISOString()).toBe(expected);
  });

  it('rolls over a month end', () => {
    const { tomorrow } = pausePresets(new Date('2026-10-31T23:30:00Z'), RIYADH);

    expect(tomorrow.toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });

  it('keeps nine o’clock across the clocks going back', () => {
    const { tomorrow } = pausePresets(new Date('2026-10-31T20:00:00Z'), LOS_ANGELES);

    expect(tomorrow.toISOString()).toBe('2026-11-01T17:00:00.000Z');
  });
});

describe('pauseDateEnd', () => {
  it('means 09:00 on the chosen day in the zone', () => {
    const result = pauseDateEnd('2026-11-05', NOW, RIYADH);

    expect(result.problem).toBeNull();
    if (result.problem === null) {
      expect(result.end.toISOString()).toBe('2026-11-05T06:00:00.000Z');
    }
  });

  it.each([
    ['', 'invalid'],
    ['not a date', 'invalid'],
    ['2026-02-31', 'invalid'],
    ['2026-10-21', 'tooSoon'],
    ['2026-10-01', 'tooSoon'],
    ['2027-10-22', 'tooFar'],
  ])('refuses %j as %s', (value, problem) => {
    expect(pauseDateEnd(value, NOW, RIYADH).problem).toBe(problem);
  });

  it('allows tomorrow and the last day inside the api’s year', () => {
    const { min, max } = pauseDateBounds(NOW, RIYADH);

    expect([min, max]).toEqual(['2026-10-22', '2027-10-20']);
    expect(pauseDateEnd(min, NOW, RIYADH).problem).toBeNull();
    expect(pauseDateEnd(max, NOW, RIYADH).problem).toBeNull();
  });

  it('counts "today" in the zone: ahead of the browser, tomorrow is already the day after', () => {
    expect(pauseDateBounds(NOW, AUCKLAND).min).toBe('2026-10-23');
    expect(pauseDateEnd('2026-10-22', NOW, AUCKLAND).problem).toBe('tooSoon');
    expect(pauseDateEnd('2026-10-22', NOW, LOS_ANGELES).problem).toBeNull();
  });
});

describe('labels', () => {
  it('writes a time today as the time alone and another day with its date, in Latin digits', () => {
    const later = '2026-10-21T17:00:00Z';
    const otherDay = '2026-10-27T09:00:00Z';

    expect(whenLabel(later, 'en', NOW.getTime(), 'UTC')).toBe('17:00');
    expect(whenLabel(otherDay, 'en', NOW.getTime(), 'UTC')).toMatch(/27 Oct.*09:00/);
    expect(whenLabel(later, 'ar', NOW.getTime(), 'UTC')).toBe('17:00');
  });

  it('writes a time in the zone given, and the day it falls on there', () => {
    expect(whenLabel('2026-10-21T22:00:00Z', 'en', NOW.getTime(), RIYADH)).toMatch(
      /Thu 22 Oct.*01:00/,
    );
    expect(whenLabel('2026-10-21T15:00:00Z', 'en', NOW.getTime(), RIYADH)).toBe('18:00');
  });

  it('writes the day of an unsubscribe and an hour of the digest', () => {
    expect(dayLabel(new Date(2026, 9, 3, 12).toISOString(), 'en')).toBe('3 Oct');
    expect(hourLabel(7)).toBe('07:00');
    expect(hourLabel(23)).toBe('23:00');
  });
});
