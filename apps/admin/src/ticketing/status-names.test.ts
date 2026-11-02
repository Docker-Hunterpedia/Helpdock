import { describe, expect, it } from 'vitest';
import { statusLabel, statusNames } from './status-names.js';

const open = { name: 'Open', nameAr: 'مفتوحة' };

describe('statusNames', () => {
  it('leads with the English name in English and puts the Arabic one under it', () => {
    expect(statusNames(open, 'en')).toEqual({
      primary: 'Open',
      primaryLang: 'en',
      secondary: 'مفتوحة',
      secondaryLang: 'ar',
    });
  });

  it('leads with the Arabic name in the Arabic UI', () => {
    expect(statusNames(open, 'ar')).toEqual({
      primary: 'مفتوحة',
      primaryLang: 'ar',
      secondary: 'Open',
      secondaryLang: 'en',
    });
  });

  it('falls back to the one name when there is no Arabic name', () => {
    expect(statusNames({ name: 'Waiting', nameAr: null }, 'ar').primary).toBe('Waiting');
    expect(statusNames({ name: 'Waiting', nameAr: '  ' }, 'ar').secondary).toBeNull();
    expect(statusLabel({ name: 'Waiting', nameAr: null }, 'ar')).toBe('Waiting');
  });
});
