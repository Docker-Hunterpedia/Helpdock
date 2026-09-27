import { defaultWeeklyHours, type SlaCondition } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { DepartmentActor } from '../brands/department-scope.js';
import { holidayRefusal, hoursUpdateRefusal, policyRefusal, reorderRefusal } from './sla-scope.js';

const BILLING = '01937f5e-7e53-7000-8000-0000000000d1';
const SALES = '01937f5e-7e53-7000-8000-0000000000d2';

const admin: DepartmentActor = { userId: 'a', role: 'admin', departmentIds: 'all' };
const leader: DepartmentActor = { userId: 't', role: 'team_leader', departmentIds: [BILLING] };

const brand = { timezone: 'Asia/Riyadh', weekly: defaultWeeklyHours() };
const current = { brand, overrides: new Map() };

describe('hoursUpdateRefusal', () => {
  it('lets an Admin change anything', () => {
    expect(
      hoursUpdateRefusal(admin, current, { brand: { ...brand, timezone: 'UTC' }, departments: [] }),
    ).toBeNull();
  });

  it('keeps the brand hours and zone with the Admin', () => {
    expect(
      hoursUpdateRefusal(leader, current, {
        brand: { ...brand, timezone: 'UTC' },
        departments: [],
      }),
    ).toBe('out-of-scope');
  });

  it('lets a Team Leader change only the departments they lead', () => {
    expect(
      hoursUpdateRefusal(leader, current, {
        brand,
        departments: [
          { departmentId: BILLING, override: brand },
          // Unchanged, so it does not count against them.
          { departmentId: SALES, override: null },
        ],
      }),
    ).toBeNull();
    expect(
      hoursUpdateRefusal(leader, current, {
        brand,
        departments: [{ departmentId: SALES, override: brand }],
      }),
    ).toBe('out-of-scope');
  });
});

describe('holidayRefusal', () => {
  it('keeps a brand-wide holiday with the Admin and a department one with its leader', () => {
    expect(holidayRefusal(admin, null)).toBeNull();
    expect(holidayRefusal(leader, null)).toBe('out-of-scope');
    expect(holidayRefusal(leader, BILLING)).toBeNull();
    expect(holidayRefusal(leader, SALES)).toBe('out-of-scope');
  });
});

describe('policyRefusal', () => {
  const own: SlaCondition[] = [{ field: 'department', operator: 'any', values: [BILLING] }];

  it('lets a Team Leader own a policy confined to their departments, before and after', () => {
    expect(policyRefusal(leader, own)).toBeNull();
    expect(
      policyRefusal(leader, own, [{ field: 'department', operator: 'any', values: [SALES] }]),
    ).toBe('out-of-scope');
  });

  it('keeps an unconfined or "none of" policy with the Admin', () => {
    expect(policyRefusal(leader, [])).toBe('out-of-scope');
    expect(
      policyRefusal(leader, [{ field: 'department', operator: 'none', values: [SALES] }]),
    ).toBe('out-of-scope');
    expect(policyRefusal(admin, [])).toBeNull();
  });

  it('keeps the order with the Admin', () => {
    expect(reorderRefusal(admin)).toBeNull();
    expect(reorderRefusal(leader)).toBe('out-of-scope');
  });
});
