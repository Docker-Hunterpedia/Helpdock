import { describe, expect, it } from 'vitest';
import { lastUsedLabel, sampleValues } from './macro-format.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const t = (key: string): string => key;

describe('lastUsedLabel', () => {
  it('says never, and just now', () => {
    expect(lastUsedLabel(null, 'en', NOW, t)).toBe('macros:list.never');
    expect(lastUsedLabel('2026-09-27T11:59:30Z', 'en', NOW, t)).toBe('macros:list.justNow');
  });

  it('counts minutes, hours and days in the reader’s language', () => {
    expect(lastUsedLabel('2026-09-27T11:48:00Z', 'en', NOW, t)).toBe('12 min. ago');
    expect(lastUsedLabel('2026-09-27T11:00:00Z', 'en', NOW, t)).toBe('1 hr. ago');
    expect(lastUsedLabel('2026-09-26T11:00:00Z', 'en', NOW, t)).toBe('yesterday');
    expect(lastUsedLabel('2026-09-26T11:00:00Z', 'ar', NOW, t)).toBe('أمس');
  });
});

describe('sampleValues', () => {
  it('fills the sample contact and ticket, and the real brand and sender', () => {
    const values = sampleValues({ brand: 'Helpdock', agent: 'Lina Haddad' });

    expect(Object.fromEntries(values)).toEqual({
      'contact.first_name': 'Mona',
      'contact.last_name': 'Khalil',
      'contact.name': 'Mona Khalil',
      'contact.email': 'mona@example.com',
      'ticket.number': 'HD-1042',
      'brand.name': 'Helpdock',
      'agent.first_name': 'Lina',
    });
  });
});
