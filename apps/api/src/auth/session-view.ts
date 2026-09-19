import type { Brand } from '@helpdock/db';
import type {
  BrandMembership,
  BrandRole,
  Session,
  SessionBrand,
  StaffRole,
} from '@helpdock/schemas';
import type { StaffMembership, StaffUser } from './staff.repository.js';

/**
 * Turns rows into the session the admin app reads, and into the claims an
 * access token carries. The two must describe the same person, so they are
 * built side by side here rather than in whichever service happened to need one.
 */

/**
 * The database and the principal spell a role `team_leader`; the admin app
 * spells it `teamLeader`. Neither is wrong and neither is going to change, so
 * the translation lives in one place and is exhaustive by type.
 */
const ROLE_TO_CLIENT: Readonly<Record<BrandRole, StaffRole>> = {
  admin: 'admin',
  team_leader: 'teamLeader',
  agent: 'agent',
  viewer: 'viewer',
};

export const toClientRole = (role: BrandRole): StaffRole => ROLE_TO_CLIENT[role];

/**
 * `departmentIds` is null in the database for "every department", which is what
 * an Admin always has and an unrestricted Team Leader or Viewer may have
 * (DOMAIN-RULES §1.1).
 */
export const toBrandMembership = (membership: StaffMembership): BrandMembership => ({
  role: membership.role,
  departmentIds: membership.departmentIds ?? 'all',
});

export const toClaimBrands = (
  memberships: readonly StaffMembership[],
): Record<string, BrandMembership> => {
  const brands: Record<string, BrandMembership> = {};
  for (const membership of memberships) {
    brands[membership.brandId] = toBrandMembership(membership);
  }

  return brands;
};

/**
 * The host shown under the sign-in heading and beside the brand in the
 * switcher. Brands get their own verified domains with `brand_domains` in M5;
 * until then every brand is reached through the install's own host, which is
 * true, and is what an operator sees in their browser.
 */
export const brandDomain = (appUrl: string): string => {
  try {
    return new URL(appUrl).host;
  } catch {
    return appUrl;
  }
};

export const toSessionBrand = (brand: Brand, appUrl: string): SessionBrand => ({
  id: brand.id,
  name: brand.name,
  domain: brandDomain(appUrl),
  ticketPrefix: brand.prefix,
});

export interface BuildSessionInput {
  readonly user: StaffUser;
  readonly memberships: readonly StaffMembership[];
  readonly brands: readonly Brand[];
  readonly appUrl: string;
  /** The brand this user last worked in, if it is still one they hold a role in. */
  readonly preferredBrandId: string | null;
}

/**
 * The session, or `null` when this account cannot use the admin at all: every
 * screen is brand-scoped, so a staff member with no role in any brand has
 * nowhere to land. That is a state M0-06 prevents by always inviting into a
 * brand; it is refused here rather than answered with a session no screen can
 * render.
 */
export const buildSession = ({
  user,
  memberships,
  brands,
  appUrl,
  preferredBrandId,
}: BuildSessionInput): Session | null => {
  const byId = new Map(brands.map((brand) => [brand.id, brand]));
  const held = memberships
    .map((membership) => byId.get(membership.brandId))
    .filter((brand) => brand !== undefined);

  const first = held[0];
  if (first === undefined) {
    return null;
  }

  const currentBrandId =
    preferredBrandId !== null &&
    byId.has(preferredBrandId) &&
    held.some((b) => b.id === preferredBrandId)
      ? preferredBrandId
      : first.id;

  const currentRole = memberships.find((membership) => membership.brandId === currentBrandId);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      // `currentRole` is always found: `currentBrandId` came from `held`, which
      // is built from the memberships themselves.
      role: toClientRole(currentRole?.role ?? 'viewer'),
      installAdmin: user.installAdmin,
    },
    brands: held.map((brand) => toSessionBrand(brand, appUrl)),
    currentBrandId,
  };
};
