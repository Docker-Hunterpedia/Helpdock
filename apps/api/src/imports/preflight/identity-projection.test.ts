import { expect, it } from 'vitest';
import {
  contactIdentityProjection,
  organizationIdentityProjection,
} from './identity-projection.js';

it('hashes canonical contact claims independently of source IDs and omits claims for unchanged receipts', () => {
  const plan = {
    action: 'create' as const,
    contactId: null,
    accountId: null,
    sourceAccountId: null,
    name: 'Person',
    sourceName: 'Person',
    identifiers: [{ kind: 'email' as const, value: 'private@example.test' }],
    refusedPhones: 0,
    organization: null,
  };
  const first = contactIdentityProjection({
    externalId: 'private@example.test',
    inputHash: 'a'.repeat(64),
    plan,
  });
  const second = contactIdentityProjection({ externalId: 'b', inputHash: 'b'.repeat(64), plan });
  expect(first.claims).toEqual(second.claims);
  expect(first.destination).not.toBe(second.destination);
  expect(JSON.stringify(first)).not.toContain('private@example.test');
  expect(
    contactIdentityProjection({
      externalId: 'a',
      inputHash: 'a'.repeat(64),
      plan: { ...plan, action: 'unchanged' },
    }).claims,
  ).toEqual([]);
});

it('permits company source aliases to claim the same existing target and omits unchanged domain claims', () => {
  const plan = {
    action: 'link' as const,
    accountId: '01900000-0000-7000-8000-000000000001',
    name: 'Company',
    sourceName: 'Company',
    domains: ['private.example'],
  };
  const first = organizationIdentityProjection({
    externalId: 'private@example.test',
    inputHash: 'a'.repeat(64),
    plan,
  });
  const second = organizationIdentityProjection({
    externalId: 'b',
    inputHash: 'b'.repeat(64),
    plan,
  });
  expect(first.destination).toBe(second.destination);
  expect(first.claims).toEqual(second.claims);
  expect(JSON.stringify(first)).not.toContain('private.example');
  expect(
    JSON.stringify(
      organizationIdentityProjection({
        externalId: 'private.example',
        inputHash: 'a'.repeat(64),
        plan: { ...plan, action: 'create', accountId: null },
      }),
    ),
  ).not.toContain('private.example');
  expect(
    organizationIdentityProjection({
      externalId: 'private.example',
      inputHash: 'a'.repeat(64),
      plan: { ...plan, action: 'unchanged' },
    }).claims,
  ).toEqual([]);
});
