import type { BrandRole, Principal } from './principal.js';

/**
 * Layer 1 of DOMAIN-RULES §1.3: what a role may ask for, checked on the route
 * before anything reaches the database. The matrix is
 * [§1.2](../../../../docs/planning/DOMAIN-RULES.md#12-scope-rules) transcribed;
 * when the two disagree, this file is wrong.
 *
 * | Role | Sees tickets | Edits tickets | Manages config |
 * |---|---|---|---|
 * | Admin | Whole brand | Yes | Everything in the brand |
 * | Team Leader | Their departments | Yes | Departments they lead |
 * | Agent | Their departments only | Tickets in their departments | Nothing |
 * | Viewer | Their departments | No | Nothing |
 *
 * *Which* departments a role reaches is not decided here: that is the tenant
 * transaction and the row-level security policies (layers 2 and 3).
 *
 * The list is what M0 needs plus the ticket permissions, so M1 extends it
 * rather than inventing a second vocabulary.
 *
 * `staff:read` is the one permission every role holds. §1.2 restricts *tickets*
 * by department, never colleagues: an Agent has to see which of them is online
 * before taking a ticket (M1-07 assignment, M1-09 collision), and a Viewer
 * reading reports is reading about the same people. Changing who may work in
 * the brand stays `staff:manage`.
 */
export const PERMISSIONS = [
  'ticket:read',
  'ticket:write',
  'contact:read',
  'brand:read',
  'brand:manage',
  'staff:read',
  'staff:manage',
  'settings:read',
  'settings:write',
  'system:read',
  'install:admin',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The one permission no role grants. It is held by `installAdmin` alone, the
 * only principal that may run "all brands" paths (DOMAIN-RULES §1.1), and a
 * route that asks for it runs in install scope and is audited.
 */
export const INSTALL_ADMIN: Permission = 'install:admin';

export const rolePermissions: Readonly<Record<BrandRole, readonly Permission[]>> = Object.freeze({
  admin: [
    'ticket:read',
    'ticket:write',
    'contact:read',
    'brand:read',
    'brand:manage',
    'staff:read',
    'staff:manage',
    'settings:read',
    'settings:write',
    'system:read',
  ],
  // "Departments they lead: agents, SLAs, rules, macros, canned responses, help
  // center, widget theme, content policy, reopen policy" — brand-level
  // configuration such as the prefix or the timezone stays with Admin.
  team_leader: [
    'ticket:read',
    'ticket:write',
    'contact:read',
    'brand:read',
    'staff:read',
    'staff:manage',
    'settings:read',
    'settings:write',
  ],
  agent: ['ticket:read', 'ticket:write', 'contact:read', 'brand:read', 'staff:read'],
  viewer: ['ticket:read', 'contact:read', 'brand:read', 'staff:read'],
});

export const roleHasPermission = (role: BrandRole, permission: Permission): boolean =>
  rolePermissions[role].includes(permission);

/** The only principal that may run "all brands" paths (DOMAIN-RULES §1.1). */
export const isInstallAdmin = (principal: Principal): boolean =>
  principal.type === 'staff' && principal.installAdmin;

/**
 * Whether the principal may exercise `permission` in `brandId`.
 *
 * `installAdmin` is deliberately not a wildcard: DOMAIN-RULES §1.1 makes it the
 * principal that may run all-brands paths, not one that inherits every brand
 * role. An install admin reaches a brand's tickets by being given a role in it.
 */
export const principalHasPermission = (
  principal: Principal,
  brandId: string,
  permission: Permission,
): boolean => {
  if (permission === INSTALL_ADMIN) {
    return isInstallAdmin(principal);
  }

  switch (principal.type) {
    case 'staff': {
      const membership = principal.brands[brandId];
      return membership !== undefined && roleHasPermission(membership.role, permission);
    }
    case 'apikey':
      // Scopes are issued per key and are the permission names themselves
      // (M8-01); a key never reaches a brand other than the one it belongs to.
      return principal.brandId === brandId && principal.scopes.includes(permission);
    case 'visitor':
    case 'system':
      // Visitors get their own endpoints in M4 with their own checks, and a
      // worker never arrives over HTTP (DOMAIN-RULES §1.4).
      return false;
  }
};
