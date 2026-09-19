import { describe, expect, it } from 'vitest';
import {
  contactCreateRequestSchema,
  contactSearchQuerySchema,
  contactUpdateRequestSchema,
  MAX_IDENTITY_LENGTH,
  normaliseEmail,
  normaliseExternal,
  normaliseIdentity,
  normalisePhone,
  normaliseTelegram,
  normaliseVisitor,
  toLatinDigits,
  VERIFIABLE_IDENTITY_KINDS,
} from './contact.js';

/**
 * Normalisation is the whole mechanism behind "one person is one contact": the
 * unique index on `contact_identities` compares the spelled value, so every
 * spelling of one identifier has to come out the same. These are the spellings
 * a real support desk receives.
 */

const value = (result: ReturnType<typeof normaliseEmail>): string | undefined =>
  result.ok ? result.value : undefined;

const problem = (result: ReturnType<typeof normaliseEmail>): string | undefined =>
  result.ok ? undefined : result.problem;

describe('toLatinDigits', () => {
  it('converts Arabic-Indic digits', () => {
    expect(toLatinDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('converts Eastern Arabic-Indic digits', () => {
    expect(toLatinDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('leaves Latin digits and letters alone', () => {
    expect(toLatinDigits('+49 30 مرحبا 7')).toBe('+49 30 مرحبا 7');
  });
});

describe('normaliseEmail', () => {
  it.each([
    ['Mona@Example.COM', 'mona@example.com'],
    ['  mona@example.com  ', 'mona@example.com'],
    ['MONA+support@Example.com', 'mona+support@example.com'],
  ])('lower-cases and trims %s', (raw, expected) => {
    expect(value(normaliseEmail(raw))).toBe(expected);
  });

  it.each(['', '   '])('refuses %s as empty', (raw) => {
    expect(problem(normaliseEmail(raw))).toBe('empty');
  });

  it.each(['mona', 'mona@', '@example.com', 'mona example.com'])('refuses %s', (raw) => {
    expect(problem(normaliseEmail(raw))).toBe('invalid-email');
  });

  it('refuses an address longer than the column', () => {
    const long = `${'a'.repeat(MAX_IDENTITY_LENGTH)}@example.com`;

    expect(problem(normaliseEmail(long))).toBe('too-long');
  });
});

describe('normalisePhone', () => {
  it.each([
    ['+49 30 1234 567', '+49301234567'],
    ['+49-30-1234-567', '+49301234567'],
    ['+49 (30) 1234.567', '+49301234567'],
    ['004930 1234567', '+49301234567'],
  ])('brings %s to E.164', (raw, expected) => {
    expect(value(normalisePhone(raw))).toBe(expected);
  });

  it('accepts Arabic-Indic digits, which is how an Arabic keyboard types one', () => {
    expect(value(normalisePhone('+٩٦٣٩٣١٢٣٤٥٦٧'))).toBe('+963931234567');
  });

  it('accepts a number written with the Arabic thousands separator', () => {
    expect(value(normalisePhone('+٩٦٣٬٩٣١٬٢٣٤٬٥٦٧'))).toBe('+963931234567');
  });

  it('refuses a national number when the brand has no calling code', () => {
    expect(problem(normalisePhone('030 1234567'))).toBe('phone-not-international');
  });

  it('prefixes the brand calling code and drops the trunk zero', () => {
    expect(value(normalisePhone('030 1234567', { defaultCallingCode: '49' }))).toBe('+49301234567');
  });

  it('accepts a calling code written with its plus', () => {
    expect(value(normalisePhone('0301234567', { defaultCallingCode: '+49' }))).toBe('+49301234567');
  });

  it('ignores a calling code that is not one', () => {
    expect(problem(normalisePhone('0301234567', { defaultCallingCode: 'DE' }))).toBe(
      'phone-not-international',
    );
  });

  it.each([
    ['+49', 'invalid-phone'],
    ['+49 30 12', 'invalid-phone'],
    ['+49 30 ext 12', 'invalid-phone'],
    ['', 'empty'],
  ])('refuses %s', (raw, expected) => {
    expect(problem(normalisePhone(raw))).toBe(expected);
  });

  it('refuses more than the fifteen digits E.164 allows', () => {
    expect(problem(normalisePhone(`+${'9'.repeat(16)}`))).toBe('too-long');
  });

  it('refuses a national number that is nothing but zeroes', () => {
    expect(problem(normalisePhone('000', { defaultCallingCode: '49' }))).toBe('invalid-phone');
  });

  it('is idempotent, so re-saving a stored number changes nothing', () => {
    const once = value(normalisePhone('+49 30 1234 567'));

    expect(value(normalisePhone(once ?? ''))).toBe(once);
  });
});

describe('normaliseTelegram', () => {
  it.each([
    ['123456789', '123456789'],
    [' 123456789 ', '123456789'],
    ['-1001234567890', '-1001234567890'],
    ['١٢٣٤٥٦٧٨٩', '123456789'],
  ])('keeps %s as a chat id', (raw, expected) => {
    expect(value(normaliseTelegram(raw))).toBe(expected);
  });

  it.each(['@mona', 'mona', '12.34'])('refuses %s', (raw) => {
    expect(problem(normaliseTelegram(raw))).toBe('invalid-telegram');
  });

  it('refuses an empty chat id', () => {
    expect(problem(normaliseTelegram('  '))).toBe('empty');
  });
});

describe('normaliseVisitor', () => {
  it('lower-cases the uuid the widget was issued', () => {
    expect(value(normaliseVisitor('0192C3F0-1A2B-7C3D-8E4F-000000000001'))).toBe(
      '0192c3f0-1a2b-7c3d-8e4f-000000000001',
    );
  });

  it.each(['visitor-7f3a', '0192c3f0'])('refuses %s', (raw) => {
    expect(problem(normaliseVisitor(raw))).toBe('invalid-visitor');
  });

  it('refuses an empty visitor id', () => {
    expect(problem(normaliseVisitor(''))).toBe('empty');
  });
});

describe('normaliseExternal', () => {
  it('trims but never case-folds: the brand chose the spelling', () => {
    expect(value(normaliseExternal('  Cust-0042  '))).toBe('Cust-0042');
  });

  it('refuses an empty id', () => {
    expect(problem(normaliseExternal(' '))).toBe('empty');
  });

  it('refuses one longer than the column', () => {
    expect(problem(normaliseExternal('x'.repeat(MAX_IDENTITY_LENGTH + 1)))).toBe('too-long');
  });
});

describe('normaliseIdentity', () => {
  it.each([
    ['email', 'Mona@Example.com', 'mona@example.com'],
    ['phone', '+49 30 1234 567', '+49301234567'],
    ['telegram', ' 42 ', '42'],
    ['visitor', '0192C3F0-1A2B-7C3D-8E4F-000000000001', '0192c3f0-1a2b-7c3d-8e4f-000000000001'],
    ['external', ' Cust-1 ', 'Cust-1'],
  ] as const)('dispatches %s to its own normaliser', (kind, raw, expected) => {
    expect(value(normaliseIdentity(kind, raw))).toBe(expected);
  });

  it('passes the brand calling code through to phone numbers alone', () => {
    expect(value(normaliseIdentity('phone', '0301234567', { defaultCallingCode: '49' }))).toBe(
      '+49301234567',
    );
  });
});

describe('VERIFIABLE_IDENTITY_KINDS', () => {
  it('matches the DOMAIN-RULES §4.4 table, phone included', () => {
    expect(VERIFIABLE_IDENTITY_KINDS).toEqual({
      email: true,
      telegram: true,
      external: true,
      visitor: true,
      phone: false,
    });
  });
});

describe('the request schemas', () => {
  it('defaults a contact to no identifiers rather than refusing one', () => {
    const parsed = contactCreateRequestSchema.parse({ name: 'Mona Khalil' });

    expect(parsed.identities).toEqual([]);
  });

  it('trims the name, so "  Mona " and "Mona" are one person', () => {
    expect(contactCreateRequestSchema.parse({ name: '  Mona  ' }).name).toBe('Mona');
  });

  it('refuses an update that changes nothing', () => {
    expect(contactUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an update that only clears the account', () => {
    expect(contactUpdateRequestSchema.safeParse({ accountId: null }).success).toBe(true);
  });

  it('reads the filter flags out of the query string', () => {
    const parsed = contactSearchQuerySchema.parse({ hasOpenTickets: 'true', limit: '25' });

    expect(parsed).toMatchObject({ hasOpenTickets: true, limit: 25 });
  });

  it('refuses a page larger than the one the list draws', () => {
    expect(contactSearchQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('contactSearchQuerySchema, applied twice', () => {
  it('survives a second pass, because the query is parsed by two pipes', () => {
    // The global `ZodValidationPipe` and the one the parameter names both run.
    // `z.stringbool()` alone refuses the boolean the first produced, which made
    // `?hasOpenTickets=true` a 400 rather than a filter.
    const once = contactSearchQuerySchema.parse({ hasOpenTickets: 'true', duplicates: 'false' });

    expect(once).toMatchObject({ hasOpenTickets: true, duplicates: false });
    expect(contactSearchQuerySchema.parse(once)).toEqual(once);
  });

  it('still refuses a value that is neither', () => {
    expect(contactSearchQuerySchema.safeParse({ hasOpenTickets: 'perhaps' }).success).toBe(false);
  });
});
