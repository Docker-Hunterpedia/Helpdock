import type { Brand } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { brandDomain, buildSession, toClaimBrands, toClientRole } from './session-view.js';
import type { StaffMembership, StaffUser } from './staff.repository.js';

const APP_URL = 'https://support.example.com';
const USER_ID = uuidv7();
const BRAND_A = uuidv7();
const BRAND_B = uuidv7();

const user: StaffUser = {
  id: USER_ID,
  email: 'lina@helpdock.com',
  name: 'Lina Haddad',
  passwordHash: null,
  totpSecretEncrypted: null,
  totpEnabled: false,
  recoveryCodesHashed: [],
  locale: 'en',
  status: 'active',
  installAdmin: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  deactivatedAt: null,
};

const brand = (id: string, name: string, prefix: string): Brand => ({
  id,
  name,
  prefix,
  defaultLocale: 'en',
  timezone: 'UTC',
  status: 'active',
  settings: {},
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const membership = (
  brandId: string,
  role: StaffMembership['role'],
  departmentIds: string[] | null = null,
): StaffMembership => ({
  id: uuidv7(),
  userId: USER_ID,
  brandId,
  role,
  departmentIds,
  createdAt: new Date(),
});

describe('toClientRole', () => {
  it('maps every database role to the spelling the admin screens use', () => {
    expect([
      toClientRole('admin'),
      toClientRole('team_leader'),
      toClientRole('agent'),
      toClientRole('viewer'),
    ]).toEqual(['admin', 'teamLeader', 'agent', 'viewer']);
  });
});

describe('toClaimBrands', () => {
  it('turns a null department list into "all", which is what an Admin holds', () => {
    expect(toClaimBrands([membership(BRAND_A, 'admin')])).toEqual({
      [BRAND_A]: { role: 'admin', departmentIds: 'all' },
    });
  });

  it('keeps an explicit list, which is what an Agent holds', () => {
    expect(toClaimBrands([membership(BRAND_A, 'agent', [BRAND_B])])).toEqual({
      [BRAND_A]: { role: 'agent', departmentIds: [BRAND_B] },
    });
  });
});

describe('brandDomain', () => {
  it('is the install host until M5 brings verified brand domains', () => {
    expect(brandDomain(APP_URL)).toBe('support.example.com');
  });

  it('answers something rather than throwing for a value that is not a URL', () => {
    expect(brandDomain('nonsense')).toBe('nonsense');
  });
});

describe('buildSession', () => {
  const base = {
    user,
    appUrl: APP_URL,
    preferredBrandId: null,
  };

  it('lists the brands the user holds a role in, with their prefixes', () => {
    const session = buildSession({
      ...base,
      memberships: [membership(BRAND_A, 'admin'), membership(BRAND_B, 'agent', [])],
      brands: [brand(BRAND_A, 'Helpdock', 'HD'), brand(BRAND_B, 'Helpdock EU', 'HDE')],
    });

    expect(session?.brands).toEqual([
      { id: BRAND_A, name: 'Helpdock', domain: 'support.example.com', ticketPrefix: 'HD' },
      { id: BRAND_B, name: 'Helpdock EU', domain: 'support.example.com', ticketPrefix: 'HDE' },
    ]);
  });

  it('shows the role held in the current brand, not the first one alphabetically', () => {
    const session = buildSession({
      ...base,
      preferredBrandId: BRAND_B,
      memberships: [membership(BRAND_A, 'admin'), membership(BRAND_B, 'agent', [])],
      brands: [brand(BRAND_A, 'Helpdock', 'HD'), brand(BRAND_B, 'Helpdock EU', 'HDE')],
    });

    expect(session).toMatchObject({ currentBrandId: BRAND_B, user: { role: 'agent' } });
  });

  it('falls back to the first brand when the remembered one is gone', () => {
    const session = buildSession({
      ...base,
      preferredBrandId: uuidv7(),
      memberships: [membership(BRAND_A, 'admin')],
      brands: [brand(BRAND_A, 'Helpdock', 'HD')],
    });

    expect(session?.currentBrandId).toBe(BRAND_A);
  });

  it('drops a membership whose brand is no longer active', () => {
    const session = buildSession({
      ...base,
      memberships: [membership(BRAND_A, 'admin'), membership(BRAND_B, 'agent', [])],
      brands: [brand(BRAND_A, 'Helpdock', 'HD')],
    });

    expect(session?.brands.map((found) => found.id)).toEqual([BRAND_A]);
  });

  it('answers null when there is no brand to land in, rather than an empty session', () => {
    expect(buildSession({ ...base, memberships: [], brands: [] })).toBeNull();
    expect(
      buildSession({ ...base, memberships: [membership(BRAND_A, 'admin')], brands: [] }),
    ).toBeNull();
  });

  it('marks an install admin as one, which is what the user menu shows', () => {
    const session = buildSession({
      ...base,
      user: { ...user, installAdmin: true },
      memberships: [membership(BRAND_A, 'viewer')],
      brands: [brand(BRAND_A, 'Helpdock', 'HD')],
    });

    expect(session?.user).toMatchObject({ installAdmin: true, role: 'viewer' });
  });

  it('never carries a password hash or a TOTP secret into the response', () => {
    const session = buildSession({
      ...base,
      user: { ...user, passwordHash: '$argon2id$secret', totpSecretEncrypted: 'v1.abc' },
      memberships: [membership(BRAND_A, 'admin')],
      brands: [brand(BRAND_A, 'Helpdock', 'HD')],
    });

    expect(JSON.stringify(session)).not.toContain('argon2id');
    expect(JSON.stringify(session)).not.toContain('v1.abc');
  });
});
