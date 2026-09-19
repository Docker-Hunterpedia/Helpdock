import type { BrandRole, StaffRefusal } from '@helpdock/schemas';

/**
 * Who may do what to whom, inside one brand. It is
 * [DOMAIN-RULES §1.2](../../../../docs/planning/DOMAIN-RULES.md#12-scope-rules)
 * and §12 transcribed; when the two disagree, this file is wrong.
 *
 * The permission guard has already established that the actor holds
 * `staff:manage` in this brand, which only an Admin and a Team Leader do. What
 * is left is the part a permission cannot express:
 *
 * - **An Admin manages the brand.** Every role, every department.
 * - **A Team Leader manages agents and viewers in their own departments.** Not
 *   another leader, not an admin, and not an agent whose departments they do
 *   not lead — in either direction, so they can neither reach outside their
 *   scope nor move somebody into it.
 * - **Nobody changes or deactivates themselves.** An admin who demotes
 *   themselves by accident leaves a brand with no administrator and no way
 *   back; refusing is cheaper than recovering.
 * - **The last install admin stays.** It is the only principal that may run
 *   all-brands paths (DOMAIN-RULES §1.1), so an install with none has locked
 *   its own operator out.
 *
 * Everything here is a pure function of values the caller has already read, so
 * the matrix is testable without a database and is decided in one place rather
 * than once per route.
 */

export interface StaffActor {
  readonly userId: string;
  readonly role: BrandRole;
  /** `'all'` for an Admin, and for an unrestricted Team Leader or Viewer. */
  readonly departmentIds: readonly string[] | 'all';
  readonly installAdmin: boolean;
}

export interface StaffTarget {
  readonly userId: string;
  readonly role: BrandRole;
  readonly departmentIds: readonly string[] | 'all';
}

/** The roles a Team Leader may touch at all (DOMAIN-RULES §1.2). */
const LED_ROLES: readonly BrandRole[] = ['agent', 'viewer'];

/**
 * Whether `outer` covers `inner`. `'all'` covers everything, and nothing but
 * `'all'` covers `'all'`: a leader of two departments does not lead a person
 * who is in every department.
 */
export const scopeCovers = (
  outer: readonly string[] | 'all',
  inner: readonly string[] | 'all',
): boolean => {
  if (outer === 'all') {
    return true;
  }
  if (inner === 'all') {
    return false;
  }

  const held = new Set(outer);
  return inner.every((departmentId) => held.has(departmentId));
};

/** Whether the actor may act on this person's membership at all. */
export const canManage = (actor: StaffActor, target: StaffTarget): boolean => {
  if (actor.role === 'admin') {
    return true;
  }
  if (actor.role !== 'team_leader') {
    return false;
  }

  return LED_ROLES.includes(target.role) && scopeCovers(actor.departmentIds, target.departmentIds);
};

/** Whether the actor may hand out this role with this scope. */
export const canAssign = (
  actor: StaffActor,
  role: BrandRole,
  departmentIds: readonly string[] | 'all',
): boolean => {
  if (actor.role === 'admin') {
    return true;
  }
  if (actor.role !== 'team_leader') {
    return false;
  }

  return LED_ROLES.includes(role) && scopeCovers(actor.departmentIds, departmentIds);
};

export interface StaffActionInput {
  readonly actor: StaffActor;
  /** Absent when the action creates a membership rather than changing one. */
  readonly target?: StaffTarget | undefined;
  /** Absent when the action does not set a role, such as a deactivation. */
  readonly assigning?:
    | { readonly role: BrandRole; readonly departmentIds: readonly string[] | 'all' }
    | undefined;
  readonly viewerEnabled: boolean;
  /**
   * Whether refusing to leave the install without an administrator applies:
   * true only when the target is the install's last install admin and the
   * action would take their access away.
   */
  readonly wouldRemoveLastInstallAdmin?: boolean;
}

/**
 * The one entry point. `null` means the action is allowed.
 *
 * The order is deliberate: self first, because acting on yourself is refused
 * whatever your role and is the clearest thing to tell somebody; then the
 * install-admin floor, which no role overrides; then scope; then the viewer
 * toggle, which is a setting rather than a permission and is the least
 * surprising last word.
 */
export const staffActionRefusal = ({
  actor,
  target,
  assigning,
  viewerEnabled,
  wouldRemoveLastInstallAdmin = false,
}: StaffActionInput): StaffRefusal | null => {
  if (target !== undefined && target.userId === actor.userId) {
    return 'self';
  }

  if (wouldRemoveLastInstallAdmin) {
    return 'last-install-admin';
  }

  if (target !== undefined && !canManage(actor, target)) {
    return 'out-of-scope';
  }

  if (assigning !== undefined) {
    if (!canAssign(actor, assigning.role, assigning.departmentIds)) {
      return 'out-of-scope';
    }
    if (assigning.role === 'viewer' && !viewerEnabled) {
      return 'viewer-disabled';
    }
  }

  return null;
};
