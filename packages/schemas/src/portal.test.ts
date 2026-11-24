import { describe, expect, it } from 'vitest';
import {
  type AccountRole,
  customerSees,
  type PortalVisibility,
  portalSettingsSchema,
} from './portal.js';

describe('customerSees', () => {
  // ADR 0060 §5, as a table: setting x role x has-an-account.
  const cases: readonly [PortalVisibility, AccountRole, boolean, 'own' | 'account'][] = [
    ['own', 'member', true, 'own'],
    ['own', 'manager', true, 'own'],
    ['managers', 'member', true, 'own'],
    ['managers', 'manager', true, 'account'],
    ['all', 'member', true, 'account'],
    ['all', 'manager', true, 'account'],
    // No account: the account's id is what the policy matches on, so there is
    // nothing to widen to whatever the role says.
    ['own', 'member', false, 'own'],
    ['managers', 'manager', false, 'own'],
    ['all', 'member', false, 'own'],
    ['all', 'manager', false, 'own'],
  ];

  it.each(cases)('under %s, a %s with account=%s sees %s', (visibility, role, hasAccount, sees) => {
    expect(customerSees({ visibility, role, hasAccount })).toBe(sees);
  });
});

describe('portalSettingsSchema', () => {
  it('is off, closed to strangers and shows every department by default', () => {
    expect(portalSettingsSchema.parse({})).toEqual({
      enabled: false,
      newCustomers: false,
      departmentIds: 'all',
    });
  });

  it('keeps a list of departments, and refuses a department that is not a uuid', () => {
    const id = '01937f5e-7e53-7000-8000-00000000000a';

    expect(portalSettingsSchema.parse({ departmentIds: [id] }).departmentIds).toEqual([id]);
    expect(portalSettingsSchema.safeParse({ departmentIds: ['support'] }).success).toBe(false);
    expect(portalSettingsSchema.safeParse({ departmentIds: 'some' }).success).toBe(false);
  });
});
