import { expect, it } from 'vitest';
import { importMappingsSchema } from './import-mappings.js';

const id = '0192a000-0000-7000-8000-000000000001';

it('keeps identical source values distinct by mapping kind and supports explicit unassigned groups', () => {
  const mappings = [
    { kind: 'status', externalValue: '1', target: { statusId: id } },
    { kind: 'priority', externalValue: '1', target: { priority: 'low' } },
    { kind: 'group', externalValue: '', target: { departmentId: id, teamId: null } },
    { kind: 'tag', externalValue: 'discard', target: { tagId: null } },
    { kind: 'agent', externalValue: 'departed', target: { kind: 'name' } },
    { kind: 'field', externalValue: 'unused', target: { kind: 'skip' } },
  ];
  expect(importMappingsSchema.parse(mappings)).toEqual(mappings);
  expect(importMappingsSchema.safeParse([...mappings, mappings[0]]).success).toBe(false);
});

it.each([
  { kind: 'agent', externalValue: 'agent', target: { kind: 'invited', departmentIds: [id, id] } },
  {
    kind: 'agent',
    externalValue: 'agent',
    target: { kind: 'invited', departmentIds: [id], installAdmin: true },
  },
  {
    kind: 'agent',
    externalValue: 'agent',
    target: { kind: 'existing', userId: id, role: 'admin' },
  },
  { kind: 'channel', externalValue: 'other', target: { channel: 'unrecognized' } },
  { kind: 'priority', externalValue: 'other', target: { priority: 'critical' } },
  { kind: 'tag', externalValue: 'source\0value', target: { tagId: id } },
  { kind: 'status', externalValue: 'open', target: { statusId: id, clientSecret: 'fixture' } },
])('refuses mappings outside the approved target contract: %j', (mapping) => {
  expect(importMappingsSchema.safeParse([mapping]).success).toBe(false);
});
