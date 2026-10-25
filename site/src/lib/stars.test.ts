import { describe, expect, it } from 'vitest';
import { formatStars, parseStars, starLabel } from './stars.ts';

describe('parseStars', () => {
  it('reads the count the Pages workflow passes', () => {
    expect(parseStars('1234')).toBe(1234);
    expect(parseStars(' 0\n')).toBe(0);
  });

  it.each([undefined, '', 'null', '-3', '12.5', '1e3', 'many'])(
    'hides the count when the value is %s, rather than fail the build',
    (value) => {
      expect(parseStars(value)).toBeUndefined();
    },
  );
});

describe('formatStars', () => {
  it.each([
    [12, 'en', '12'],
    [999, 'en', '999'],
    [1234, 'en', '1.2K'],
    [15000, 'en', '15K'],
  ] as const)('shows %i as %s in English', (count, locale, shown) => {
    expect(formatStars(count, locale)).toBe(shown);
  });

  it('keeps Latin digits on Arabic pages', () => {
    expect(formatStars(1234, 'ar')).toMatch(/^1\.2\D/);
    expect(formatStars(12, 'ar')).toBe('12');
  });
});

describe('starLabel', () => {
  it('names the full count, singular or plural', () => {
    expect(starLabel(12, 'en')).toBe('Star Helpdock on GitHub, 12 stars');
    expect(starLabel(1, 'en')).toBe('Star Helpdock on GitHub, 1 star');
    expect(starLabel(1234, 'en')).toBe('Star Helpdock on GitHub, 1,234 stars');
  });

  it('drops the count when there is none', () => {
    expect(starLabel(undefined, 'en')).toBe('Star Helpdock on GitHub');
    expect(starLabel(undefined, 'ar')).toBe('أضف نجمة لـ Helpdock على GitHub');
  });
});
