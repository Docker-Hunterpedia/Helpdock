import type { BrandRole, StaffRole } from '@helpdock/schemas';

/**
 * The two spellings of a role, and the rule that decides what a role's
 * department scope means.
 *
 * `session-view.ts` maps a database role to the admin app's spelling for the
 * session; this is the other direction, which M0-06 needs because a request
 * arrives in the app's spelling and has to become a row.
 */

const ROLE_FROM_CLIENT: Readonly<Record<StaffRole, BrandRole>> = {
  admin: 'admin',
  teamLeader: 'team_leader',
  agent: 'agent',
  viewer: 'viewer',
};

export const toBrandRole = (role: StaffRole): BrandRole => ROLE_FROM_CLIENT[role];

/**
 * What `user_brand_roles.department_ids` becomes for a role and a chosen list,
 * per DOMAIN-RULES §1.1: null is "every department".
 *
 * | Role | Empty list becomes |
 * |---|---|
 * | Admin | null — an Admin sees the whole brand, whatever was chosen |
 * | Team Leader, Viewer | null — the unrestricted case §1.1 allows them |
 * | Agent | `[]` — an Agent always carries an explicit list, and an empty one means no tickets |
 *
 * The last row is the one that matters. An Agent with nothing assigned must see
 * nothing; mapping their empty list to null would hand them the whole brand,
 * which is the one mistake this function exists to make impossible.
 */
export const departmentIdsFor = (
  role: BrandRole,
  departmentIds: readonly string[],
): string[] | null => {
  if (role === 'admin') {
    return null;
  }
  if (role === 'agent') {
    return [...departmentIds];
  }

  return departmentIds.length === 0 ? null : [...departmentIds];
};

/** `'all'` when the column is null, as every reader of it expects. */
export const departmentScopeOf = (departmentIds: readonly string[] | null): string[] | 'all' =>
  departmentIds === null ? 'all' : [...departmentIds];
