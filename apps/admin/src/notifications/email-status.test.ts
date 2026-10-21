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

const NOW = new Date(2026, 9, 21, 14, 12, 0);

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

describe('pausePresets', () => {
  it('is an hour from now, 09:00 tomorrow, and a week from now', () => {
    const { hour, tomorrow, week } = pausePresets(NOW);

    expect(hour.getTime() - NOW.getTime()).toBe(3_600_000);
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([22, 9, 0]);
    expect(week.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
  });

  it('rolls over a month end', () => {
    const { tomorrow } = pausePresets(new Date(2026, 9, 31, 23, 30));

    expect([tomorrow.getMonth(), tomorrow.getDate(), tomorrow.getHours()]).toEqual([10, 1, 9]);
  });
});

describe('pauseDateEnd', () => {
  it('means 09:00 on the chosen day', () => {
    const result = pauseDateEnd('2026-11-05', NOW);

    expect(result.problem).toBeNull();
    if (result.problem === null) {
      expect([result.end.getMonth(), result.end.getDate(), result.end.getHours()]).toEqual([
        10, 5, 9,
      ]);
    }
  });

  it.each([
    ['', 'invalid'],
    ['not a date', 'invalid'],
    ['2026-10-21', 'tooSoon'],
    ['2026-10-01', 'tooSoon'],
    ['2027-10-22', 'tooFar'],
  ])('refuses %j as %s', (value, problem) => {
    expect(pauseDateEnd(value, NOW).problem).toBe(problem);
  });

  it('allows tomorrow and the last day inside the api’s year', () => {
    const { min, max } = pauseDateBounds(NOW);

    expect([min, max]).toEqual(['2026-10-22', '2027-10-20']);
    expect(pauseDateEnd(min, NOW).problem).toBeNull();
    expect(pauseDateEnd(max, NOW).problem).toBeNull();
  });
});

describe('labels', () => {
  it('writes a time today as the time alone and another day with its date, in Latin digits', () => {
    const later = new Date(2026, 9, 21, 17, 0).toISOString();
    const otherDay = new Date(2026, 9, 27, 9, 0).toISOString();

    expect(whenLabel(later, 'en', NOW.getTime())).toBe('17:00');
    expect(whenLabel(otherDay, 'en', NOW.getTime())).toMatch(/27 Oct.*09:00/);
    expect(whenLabel(later, 'ar', NOW.getTime())).toBe('17:00');
  });

  it('writes the day of an unsubscribe and an hour of the digest', () => {
    expect(dayLabel(new Date(2026, 9, 3, 12).toISOString(), 'en')).toBe('3 Oct');
    expect(hourLabel(7)).toBe('07:00');
    expect(hourLabel(23)).toBe('23:00');
  });
});
