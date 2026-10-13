import { uuidv7 } from '@helpdock/db';
import { expect, it } from 'vitest';
import { contactLoadSchema } from './profile-contracts.js';
import { importedContactIdentifiers } from './profile-identities.js';

it('deduplicates case variants and international phone formats without guessing a country', () => {
  const input = contactLoadSchema.parse({
    brandId: uuidv7(),
    runId: uuidv7(),
    source: 'file',
    accountId: null,
    custom: {},
    record: {
      externalId: 'c1',
      name: 'Customer',
      emails: ['ADA@example.com', 'ada@example.com'],
      phones: ['+٩٦٣ ٩٣١ ٢٣٤٥٦٧', '00963931234567', '0931234567'],
      custom: {},
    },
  });
  expect(importedContactIdentifiers(input)).toEqual({
    identifiers: [
      { kind: 'email', value: 'ada@example.com' },
      { kind: 'phone', value: '+963931234567' },
    ],
    refusedPhones: 1,
  });
  input.defaultCallingCode = '963';
  expect(importedContactIdentifiers(input).refusedPhones).toBe(0);
});
