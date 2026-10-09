import { describe, expect, it } from 'vitest';
import {
  awayWhen,
  dayLabel,
  formatDuration,
  formatTime,
  initials,
  listNames,
  nextOpening,
  ordinal,
} from './format.js';
import { translatorFor } from './i18n/catalogs.js';

describe('times and days', () => {
  it('prints a 24-hour time with Latin digits in both languages', () => {
    expect(formatTime('2026-09-27T05:41:00Z', 'en', 'UTC')).toBe('05:41');
    expect(formatTime('2026-09-27T21:05:00Z', 'ar', 'UTC')).toBe('21:05');
  });

  it('says Today and Yesterday, then a weekday within the week', () => {
    const now = new Date(2026, 8, 27, 12);
    const t = translatorFor('en');

    expect(dayLabel(new Date(2026, 8, 27, 8).toISOString(), now, 'en', t)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 26, 8).toISOString(), now, 'en', t)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 25, 8).toISOString(), now, 'en', t)).toBe('Friday');
    expect(dayLabel(new Date(2026, 7, 1, 8).toISOString(), now, 'en', t)).toBe('1 August');
  });

  it('words the next opening in the brand’s own zone (WidgetStatesEN column 4)', () => {
    expect(nextOpening('2026-09-27T05:00:00Z', 'Asia/Dubai', 'en')).toEqual({
      day: 'Sunday',
      time: '09:00',
      zone: 'Gulf Standard Time',
    });
    expect(nextOpening('2026-09-27T05:00:00Z', 'Asia/Dubai', 'ar').day).toBe('الأحد');
  });
});

describe('awayWhen (M7-06, Widget/AI-EN panel 6)', () => {
  // Sunday 27 September, 09:00 in Dubai.
  const OPENING = '2026-09-27T05:00:00Z';
  const when = (now: string, locale: 'en' | 'ar' = 'en') =>
    awayWhen(OPENING, 'Asia/Dubai', new Date(now), locale);

  it.each([
    ['later today', '2026-09-27T03:30:00Z', 'today'],
    ['tomorrow', '2026-09-26T17:40:00Z', 'tomorrow'],
    ['two days away', '2026-09-25T17:40:00Z', 'weekday'],
    ['six days away', '2026-09-21T17:40:00Z', 'weekday'],
    ['seven days away', '2026-09-20T17:40:00Z', 'date'],
    // Saturday in UTC, already Sunday in Dubai: the team's calendar counts, not the visitor's.
    ['already Sunday in the team’s zone', '2026-09-26T20:30:00Z', 'today'],
  ] as const)('is %s: %s', (_label, now, key) => {
    expect(when(now).key).toBe(key);
    expect(when(now, 'ar').key).toBe(key);
  });

  it('gives the weekday, the time, the date and the zone in English', () => {
    expect(when('2026-09-25T17:40:00Z')).toEqual({
      key: 'weekday',
      day: 'Sunday',
      date: '27 September',
      time: '09:00',
      zone: 'Gulf Standard Time',
    });
  });

  it('gives them in Arabic, with Latin digits', () => {
    expect(when('2026-09-25T17:40:00Z', 'ar')).toEqual({
      key: 'weekday',
      day: 'الأحد',
      date: '27 سبتمبر',
      time: '09:00',
      zone: 'توقيت الخليج',
    });
  });

  it('counts calendar days across the end of a month and a year', () => {
    const across = (now: string) =>
      awayWhen('2027-01-02T05:00:00Z', 'Asia/Dubai', new Date(now), 'en').key;

    expect(across('2026-12-31T20:30:00Z')).toBe('tomorrow');
    expect(across('2026-12-26T10:00:00Z')).toBe('date');
  });
});

describe('small formats', () => {
  it('prints timers as m:ss', () => {
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(120)).toBe('2:00');
  });

  it('takes the first and last initials', () => {
    expect(initials('Lina Haddad')).toBe('LH');
    expect(initials('Helpdock')).toBe('H');
    expect(initials('Omar bin Khalil')).toBe('OK');
  });

  it('joins names the way each language does', () => {
    expect(listNames(['Lina', 'Karim', 'Sara'], 'en')).toBe('Lina, Karim, and Sara');
    expect(listNames(['لينا', 'كريم'], 'ar')).toBe('لينا وكريم');
  });

  it('writes English ordinals and leaves Arabic to its sentence', () => {
    expect(ordinal(2, 'en', translatorFor('en'))).toBe('2nd');
    expect(ordinal(11, 'en', translatorFor('en'))).toBe('11th');
    expect(ordinal(2, 'ar', translatorFor('ar'))).toBe('2');
  });
});
