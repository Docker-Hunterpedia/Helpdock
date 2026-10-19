import { describe, expect, it } from 'vitest';
import { formatDay, formatDayTime, latinNumbering } from './format.js';

const ARABIC_INDIC_DIGIT = /[٠-٩]/;
const MOMENT = '2026-09-05T04:07:00.000Z';

describe('the app’s date formats', () => {
  it('print the day in the reader’s language with Latin digits in both (DESIGN §7)', () => {
    expect(formatDay(MOMENT, 'en', 'UTC')).toMatch(/^5 Sep/);

    const arabic = formatDay(MOMENT, 'ar', 'UTC');
    expect(arabic).toContain('2026');
    expect(arabic).toContain('سبتمبر');
    expect(arabic).not.toMatch(ARABIC_INDIC_DIGIT);
  });

  it('print a moment as its day and a 24-hour clock', () => {
    expect(formatDayTime(MOMENT, 'en')).toMatch(/2026.*\d{2}:\d{2}/);
    expect(formatDayTime(MOMENT, 'ar')).not.toMatch(ARABIC_INDIC_DIGIT);
  });

  it('keep Latin digits for a formatter that takes the reader’s locale', () => {
    const arabic = new Intl.DateTimeFormat(latinNumbering('ar'), { dateStyle: 'medium' });

    expect(arabic.format(new Date(MOMENT))).not.toMatch(ARABIC_INDIC_DIGIT);
  });
});
