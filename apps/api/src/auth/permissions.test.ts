import type { BrandMembership, BrandRole } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  INSTALL_ADMIN,
  isInstallAdmin,
  PERMISSIONS,
  type Permission,
  principalHasPermission,
  roleHasPermission,
  rolePermissions,
} from './permissions.js';
import type { Principal } from './principal.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const USER = '01937f5e-7e53-7000-8000-000000000001';

/**
 * The matrix, written out rather than derived, so that changing
 * `rolePermissions` fails here until someone has read DOMAIN-RULES §1.2 again.
 * `install:admin` is in no row: no role grants it.
 */
const MATRIX: Readonly<Record<BrandRole, Readonly<Record<Permission, boolean>>>> = {
  admin: {
    'ticket:read': true,
    'ticket:write': true,
    'ticketing:manage': true,
    'contact:read': true,
    'contact:write': true,
    'brand:read': true,
    'brand:manage': true,
    'staff:read': true,
    'staff:manage': true,
    'settings:read': true,
    'settings:write': true,
    'system:read': true,
    'install:admin': false,
  },
  team_leader: {
    'ticket:read': true,
    'ticket:write': true,
    // M1-08. DOMAIN-RULES §2.3 makes the reopen policy "editable by Team
    // Leaders and Admins", and §1.2 lists it among what a Team Leader manages —
    // as it does the tags, custom fields and templates of M1-06.
    'ticketing:manage': true,
    'contact:read': true,
    'contact:write': true,
    'brand:read': true,
    'brand:manage': false,
    'staff:read': true,
    'staff:manage': true,
    'settings:read': true,
    'settings:write': true,
    'system:read': false,
    'install:admin': false,
  },
  agent: {
    'ticket:read': true,
    'ticket:write': true,
    'ticketing:manage': false,
    'contact:read': true,
    'contact:write': true,
    'brand:read': true,
    'brand:manage': false,
    'staff:read': true,
    'staff:manage': false,
    'settings:read': false,
    'settings:write': false,
    'system:read': false,
    'install:admin': false,
  },
  viewer: {
    'ticket:read': true,
    'ticket:write': false,
    'ticketing:manage': false,
    'contact:read': true,
    'contact:write': false,
    'brand:read': true,
    'brand:manage': false,
    'staff:read': true,
    'staff:manage': false,
    'settings:read': false,
    'settings:write': false,
    'system:read': false,
    'install:admin': false,
  },
};

const ROLES = Object.keys(MATRIX) as BrandRole[];

const staff = (brands: Record<string, BrandMembership>, installAdmin = false): Principal => ({
  type: 'staff',
  id: USER,
  brands,
  installAdmin,
});

describe('rolePermissions', () => {
  it.each(ROLES)('matches DOMAIN-RULES §1.2 for %s', (role) => {
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission(role, permission), `${role} ${permission}`).toBe(
        MATRIX[role][permission],
      );
    }
  });

  it('grants every role exactly the permissions the matrix lists', () => {
    for (const role of ROLES) {
      const granted = PERMISSIONS.filter((permission) => MATRIX[role][permission]);
      expect([...rolePermissions[role]].sort()).toEqual([...granted].sort());
    }
  });

  it('cannot be widened by a caller', () => {
    expect(Object.isFrozen(rolePermissions)).toBe(true);
  });
});

describe('principalHasPermission', () => {
  it('reads the role of the brand being asked about, not of another brand', () => {
    const principal = staff({
      [BRAND_A]: { role: 'admin', departmentIds: 'all' },
      [BRAND_B]: { role: 'viewer', departmentIds: 'all' },
    });

    expect(principalHasPermission(principal, BRAND_A, 'ticket:write')).toBe(true);
    expect(principalHasPermission(principal, BRAND_B, 'ticket:write')).toBe(false);
  });

  it('refuses a brand the principal holds no role in', () => {
    const principal = staff({ [BRAND_A]: { role: 'admin', departmentIds: 'all' } });

    expect(principalHasPermission(principal, BRAND_B, 'ticket:read')).toBe(false);
  });

  it('does not let an install admin inherit a brand role', () => {
    const principal = staff({}, true);

    expect(isInstallAdmin(principal)).toBe(true);
    expect(principalHasPermission(principal, BRAND_A, 'ticket:read')).toBe(false);
    expect(principalHasPermission(principal, BRAND_A, INSTALL_ADMIN)).toBe(true);
  });

  it('grants install:admin to nobody else', () => {
    expect(principalHasPermission(staff({}), BRAND_A, INSTALL_ADMIN)).toBe(false);
    expect(
      principalHasPermission(
        { type: 'apikey', id: USER, brandId: BRAND_A, scopes: ['install:admin'] },
        BRAND_A,
        INSTALL_ADMIN,
      ),
    ).toBe(false);
  });

  it('holds an api key to its scopes and to its own brand', () => {
    const key: Principal = {
      type: 'apikey',
      id: USER,
      brandId: BRAND_A,
      scopes: ['ticket:read'],
    };

    expect(principalHasPermission(key, BRAND_A, 'ticket:read')).toBe(true);
    expect(principalHasPermission(key, BRAND_A, 'ticket:write')).toBe(false);
    expect(principalHasPermission(key, BRAND_B, 'ticket:read')).toBe(false);
  });

  it('gives a visitor and a worker no staff permission over HTTP', () => {
    const visitor: Principal = {
      type: 'visitor',
      id: USER,
      brandId: BRAND_A,
      conversationIds: [],
    };
    const system: Principal = { type: 'system', brandId: BRAND_A, jobId: 'outbox.relay:1' };

    for (const permission of PERMISSIONS) {
      expect(principalHasPermission(visitor, BRAND_A, permission)).toBe(false);
      expect(principalHasPermission(system, BRAND_A, permission)).toBe(false);
    }
  });
});
