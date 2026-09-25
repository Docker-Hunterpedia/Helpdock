import { describe, expect, it } from 'vitest';
import { addedOn, matchesSender } from './spam-format.js';

describe('addedOn', () => {
  it('prints the day and the short month, as the artboard column does', () => {
    // The order is the locale's (`Sep 18` in `en`); the parts are the artboard's.
    expect(addedOn('2026-09-18T09:00:00.000Z', 'en')).toMatch(/^(18 Sep|Sep 18)$/);
  });

  it('keeps Latin digits in Arabic', () => {
    expect(addedOn('2026-09-18T09:00:00.000Z', 'ar')).toMatch(/18/);
    expect(addedOn('2026-09-18T09:00:00.000Z', 'ar')).not.toMatch(/[\u0660-\u0669]/);
  });
});

describe('matchesSender', () => {
  it('matches everything on an empty search', () => {
    expect(matchesSender({ value: 'promo-deals.biz' }, '  ')).toBe(true);
  });

  it('matches part of a value whatever its case', () => {
    expect(matchesSender({ value: 'spam@promo-deals.biz' }, 'PROMO')).toBe(true);
    expect(matchesSender({ value: 'spam@promo-deals.biz' }, 'other')).toBe(false);
  });

  it('matches a phone number typed with its spaces', () => {
    expect(matchesSender({ value: '+15550100' }, '555 0100')).toBe(true);
  });
});
