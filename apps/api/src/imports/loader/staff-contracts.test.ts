import { uuidv7 } from '@helpdock/db';
import { expect, it } from 'vitest';
import { staffLoadSchema } from './staff-contracts.js';

const scope = { brandId: uuidv7(), runId: uuidv7(), source: 'zendesk' };
const agent = { externalId: 'agent', kind: 'agent', name: 'Old agent', active: true };

it.each([
  [
    'customer cannot receive a staff mapping',
    { record: { ...agent, kind: 'customer' }, mapping: { kind: 'name' } },
  ],
  [
    'invitation requires an email',
    { record: agent, mapping: { kind: 'invited', departmentIds: [uuidv7()] } },
  ],
  [
    'invitation requires departments',
    {
      record: { ...agent, email: 'agent@example.com' },
      mapping: { kind: 'invited', departmentIds: [] },
    },
  ],
  [
    'invitation cannot grant install authority',
    {
      record: { ...agent, email: 'agent@example.com' },
      mapping: { kind: 'invited', departmentIds: [uuidv7()], installAdmin: true },
    },
  ],
])('%s', (_scenario, request) => {
  expect(staffLoadSchema.safeParse({ ...scope, ...request }).success).toBe(false);
});

it('allows an agent without a usable email to remain a name and accepts explicit existing mappings', () => {
  expect(
    staffLoadSchema.safeParse({ ...scope, record: agent, mapping: { kind: 'name' } }).success,
  ).toBe(true);
  expect(
    staffLoadSchema.safeParse({
      ...scope,
      record: agent,
      mapping: { kind: 'existing', userId: uuidv7() },
    }).success,
  ).toBe(true);
});
