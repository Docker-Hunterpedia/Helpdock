import { describe, expect, it } from 'vitest';
import { formatAgo, formatMessageTime } from './portal-format.js';

const NOW = new Date('2026-11-26T12:00:00Z');
const ago = (ms: number, locale: 'en' | 'ar' = 'en') =>
  formatAgo(new Date(NOW.getTime() - ms), NOW, locale, 'UTC');

describe('formatMessageTime', () => {
  const at = new Date('2026-11-10T11:48:00Z');

  it('prints the day, month and time in the brand zone, in both languages', () => {
    expect(formatMessageTime(at, 'en', 'UTC')).toBe('10 Nov, 11:48');
    expect(formatMessageTime(at, 'ar', 'UTC')).toBe('10 نوفمبر، 11:48');
    expect(formatMessageTime(at, 'en', 'Asia/Dubai')).toBe('10 Nov, 15:48');
  });

  it('falls back to UTC for a zone Intl does not know', () => {
    expect(formatMessageTime(at, 'en', 'Not/AZone')).toBe('10 Nov, 11:48');
  });
});

describe('formatAgo', () => {
  it('reads recent times in words', () => {
    expect(ago(10_000)).toBe('now');
    expect(ago(20 * 60_000)).toBe('20 minutes ago');
    expect(ago(2 * 3_600_000)).toBe('2 hours ago');
    expect(ago(24 * 3_600_000)).toBe('yesterday');
    expect(ago(3 * 86_400_000)).toBe('3 days ago');
  });

  it('gets Arabic plurals from Intl', () => {
    expect(ago(2 * 3_600_000, 'ar')).toBe('قبل ساعتين');
    expect(ago(24 * 3_600_000, 'ar')).toBe('أمس');
  });

  it('prints a date once it is a month old, and never a future time as negative', () => {
    expect(ago(40 * 86_400_000)).toBe('17 Oct 2026');
    expect(formatAgo(new Date(NOW.getTime() + 5000), NOW, 'en', 'UTC')).toBe('now');
  });
});
