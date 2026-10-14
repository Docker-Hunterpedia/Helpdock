import { expect, it } from 'vitest';
import { importAssigneeEligible } from './assignee-eligibility.js';

it.each(['active', 'invited'] as const)(
  'permits %s staff only within their explicit department scope',
  (status) => {
    const member = { role: 'agent' as const, status, departmentIds: ['support'] };
    expect(importAssigneeEligible(member, 'support')).toBe(true);
    expect(importAssigneeEligible(member, 'billing')).toBe(false);
  },
);
it('refuses a missing, deactivated or viewer assignee even with unrestricted departments', () => {
  expect(importAssigneeEligible(undefined, 'support')).toBe(false);
  expect(
    importAssigneeEligible(
      { role: 'agent', status: 'deactivated', departmentIds: null },
      'support',
    ),
  ).toBe(false);
  expect(
    importAssigneeEligible({ role: 'viewer', status: 'active', departmentIds: null }, 'support'),
  ).toBe(false);
  expect(
    importAssigneeEligible({ role: 'admin', status: 'active', departmentIds: null }, 'support'),
  ).toBe(true);
});
