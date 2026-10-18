import { uuidv7 } from '@helpdock/db';
import { expect, it } from 'vitest';
import { importedContactValues } from './contact-values.js';
import { contactLoadSchema } from './profile-contracts.js';

it.each([
  ['ar-SY', 'ar', 'Asia/Damascus'],
  ['en_US', 'en', 'UTC'],
  ['fr', null, 'Invalid/Zone'],
])(
  'maps supported regional locale %s without discarding the original profile value',
  (language, locale, timezone) => {
    const input = contactLoadSchema.parse({
      brandId: uuidv7(),
      runId: uuidv7(),
      source: 'file',
      accountId: null,
      custom: {},
      record: {
        externalId: 'c',
        name: 'Customer',
        emails: [],
        phones: ['raw local phone'],
        locale: language,
        timezone,
        custom: {},
      },
    });
    const values = importedContactValues(input);
    expect(values.locale).toBe(locale);
    expect(values.timezone).toBe(locale === null ? null : timezone);
    expect(values.importedDetails).toEqual({
      phones: ['raw local phone'],
      locale: language,
      timezone,
    });
  },
);
