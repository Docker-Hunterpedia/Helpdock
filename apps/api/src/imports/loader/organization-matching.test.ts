import { importOrganizationSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { importedOrganizationDomains } from './organization-matching.js';

it('normalizes equivalent source domains without matching empty values', () => {
  const record = importOrganizationSchema.parse({
    externalId: 'company',
    name: 'Company',
    domains: [' EXAMPLE.COM ', 'example.com', ' ', 'second.test'],
    custom: {},
  });
  expect(importedOrganizationDomains(record)).toEqual(['example.com', 'second.test']);
});
