import { expect, it } from 'vitest';
import { freshdeskCredentialsSchema } from './import-api.js';
import {
  importInventoryMappingSchema,
  importInventoryValidationSchema,
} from './import-inventory.js';

it('requires a chosen or explicitly pending inventory column and a known source location', () => {
  expect(importInventoryMappingSchema.parse({ idColumn: null, location: 'auto' })).toEqual({
    idColumn: null,
    location: 'auto',
  });
  expect(importInventoryMappingSchema.safeParse({ idColumn: '', location: 'active' }).success).toBe(
    false,
  );
  expect(
    importInventoryMappingSchema.safeParse({
      idColumn: 'ID',
      location: 'remote',
      url: 'https://example.test',
    }).success,
  ).toBe(false);
});
it('refuses inconsistent validation counts or unchecked fields', () => {
  expect(
    importInventoryValidationSchema.safeParse({
      kind: 'ticket-inventory',
      sourceRows: 5,
      records: 3,
      duplicates: 2,
    }).success,
  ).toBe(true);
  expect(
    importInventoryValidationSchema.safeParse({
      kind: 'ticket-inventory',
      sourceRows: 5,
      records: 3,
      duplicates: 1,
    }).success,
  ).toBe(false);
  expect(
    importInventoryValidationSchema.safeParse({
      kind: 'ticket-inventory',
      sourceRows: 5,
      records: 3,
      duplicates: 2,
      complete: true,
    }).success,
  ).toBe(false);
});
it.each([
  'https://acme.freshdesk.com',
  'acme/path',
  'acme@evil.test',
  'acme:443',
  'acme\n',
  '-acme',
])('refuses a Freshdesk workspace that can change the fixed API origin: %s', (domain) => {
  expect(freshdeskCredentialsSchema.safeParse({ domain, apiKey: 'synthetic-key' }).success).toBe(
    false,
  );
});
it.each(['secret:key', 'secret\nheader', 'secret token'])(
  'refuses ambiguous Basic-auth key material: %s',
  (apiKey) => {
    expect(freshdeskCredentialsSchema.safeParse({ domain: 'acme', apiKey }).success).toBe(false);
  },
);
