import { describe, expect, it } from 'vitest';
import { nameIn } from './content-reader.js';
import { hourOf } from './publish-due.job.js';

describe('nameIn', () => {
  it('prefers the reader’s language, then the default, then any name there is', () => {
    expect(nameIn({ en: 'Refunds', ar: 'المبالغ المستردة' }, 'ar', 'en')).toBe('المبالغ المستردة');
    expect(nameIn({ en: 'Refunds', ar: '' }, 'ar', 'en')).toBe('Refunds');
    expect(nameIn({ en: '', ar: 'المبالغ' }, 'en', 'en')).toBe('المبالغ');
    expect(nameIn({}, 'en', 'ar')).toBe('');
  });
});

describe('hourOf', () => {
  it('rounds down to the hour, so two sweeps in one hour add one job per brand', () => {
    expect(hourOf(new Date('2026-10-01T06:42:13.500Z'))).toBe('2026-10-01T06:00:00.000Z');
  });
});
