import { describe, expect, it } from 'vitest';
import {
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
