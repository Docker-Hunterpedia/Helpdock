import { describe, expect, it } from 'vitest';
import {
  type AccountRole,
  accountPortalUpdateSchema,
  contactPortalAccessSchema,
  type PortalSeesBecause,
  type PortalVisibility,
  portalSeesBecause,
  portalSettingsUpdateSchema,
  ticketPortalPrivateUpdateSchema,
} from './portal.js';

const A = '0190a0a0-0000-7000-8000-000000000001';
const B = '0190a0a0-0000-7000-8000-000000000002';

describe('portalSettingsUpdateSchema', () => {
  it('accepts every department and a list of departments', () => {
    expect(
      portalSettingsUpdateSchema.safeParse({
        enabled: true,
        newCustomers: false,
        departmentIds: 'all',
      }).success,
    ).toBe(true);
    expect(
      portalSettingsUpdateSchema.safeParse({
        enabled: true,
        newCustomers: true,
        departmentIds: [A, B],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['an empty "only these"', { enabled: true, newCustomers: false, departmentIds: [] }],
    ['a repeated id', { enabled: true, newCustomers: false, departmentIds: [A, A] }],
    ['an id that is not a uuid', { enabled: true, newCustomers: false, departmentIds: ['x'] }],
    ['a missing field', { enabled: true, departmentIds: 'all' }],
    ['an unknown key', { enabled: true, newCustomers: false, departmentIds: 'all', extra: 1 }],
  ])('refuses %s', (_name, body) => {
    expect(portalSettingsUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe('accountPortalUpdateSchema', () => {
  it('accepts a visibility and a list of managers', () => {
    expect(
      accountPortalUpdateSchema.safeParse({ visibility: 'managers', managerContactIds: [A] })
        .success,
    ).toBe(true);
    expect(
      accountPortalUpdateSchema.safeParse({ visibility: 'own', managerContactIds: [] }).success,
    ).toBe(true);
  });

  it.each([
    ['an unknown visibility', { visibility: 'everyone', managerContactIds: [] }],
    ['a repeated manager', { visibility: 'managers', managerContactIds: [A, A] }],
    ['a manager that is not a uuid', { visibility: 'managers', managerContactIds: ['x'] }],
    ['no managers list', { visibility: 'own' }],
  ])('refuses %s', (_name, body) => {
    expect(accountPortalUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe('ticketPortalPrivateUpdateSchema', () => {
  it('takes a boolean and nothing else', () => {
    expect(ticketPortalPrivateUpdateSchema.safeParse({ private: true }).success).toBe(true);
    expect(ticketPortalPrivateUpdateSchema.safeParse({ private: 'yes' }).success).toBe(false);
    expect(ticketPortalPrivateUpdateSchema.safeParse({ private: true, x: 1 }).success).toBe(false);
  });
});

describe('portalSeesBecause', () => {
  const cases: readonly [PortalVisibility, AccountRole, boolean, PortalSeesBecause][] = [
    ['own', 'member', false, 'no-account'],
    ['all', 'manager', false, 'no-account'],
    ['own', 'member', true, 'own'],
    ['own', 'manager', true, 'own'],
    ['managers', 'manager', true, 'manager'],
    ['managers', 'member', true, 'member-not-manager'],
    ['all', 'member', true, 'all'],
    ['all', 'manager', true, 'all'],
  ];

  it.each(cases)('%s, %s, has an account %s: %s', (visibility, role, hasAccount, expected) => {
    expect(portalSeesBecause({ visibility, role, hasAccount })).toBe(expected);
  });
});

describe('contactPortalAccessSchema', () => {
  it('has no field a session token or an address could travel in', () => {
    const shape = Object.keys(contactPortalAccessSchema.shape.sessions.element.shape);
    expect(shape).toEqual(['id', 'userAgentFamily', 'lastSeenAt', 'host']);
    expect(
      contactPortalAccessSchema.safeParse({
        signedIn: true,
        signsInWith: 'a@b.example',
        sees: 'own',
        seesBecause: 'own',
        sessions: [
          {
            id: A,
            userAgentFamily: null,
            lastSeenAt: new Date().toISOString(),
            host: 'h',
            tokenHash: 'x',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
