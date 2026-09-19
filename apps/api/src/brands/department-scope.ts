import type { BrandRole, TicketingRefusal } from '@helpdock/schemas';
import { LED_ROLES } from '../staff/staff-scope.js';

/**
 * Who may change what about a brand's departments. It is
 * [DOMAIN-RULES §1.2](../../../../docs/planning/DOMAIN-RULES.md#12-scope-rules)
 * transcribed; when the two disagree, this file is wrong.
 *
 * | Role | Departments |
 * |---|---|
 * | Admin | Creates, renames, reorders and deletes every department in the brand; puts anybody on a team |
 * | Team Leader | Edits the departments they lead — name, default team, teams — and puts Agents and Viewers on those teams |
 * | Agent, Viewer | Reads the list, changes none of it |
 *
 * The split follows the table's last column. "Everything in the brand" is the
 * Admin's; a Team Leader's is "departments they lead: agents, SLAs, rules,
 * macros, canned responses…" — the contents of a department, not which
 * departments a brand has. Adding or removing one changes how the whole brand
 * routes tickets and what every agent's scope can name, so it stays with the
 * role that owns the brand.
 *
 * The permission guard has already established that the actor holds the route's
 * permission in this brand. What is left is which *department* the action may
 * touch, which a permission cannot express.
 *
 * Everything here is a pure function of values the caller has already read, so
 * the rule is testable without a database and is decided in one place rather
 * than once per route.
 */

export interface DepartmentActor {
  readonly userId: string;
  readonly role: BrandRole;
  /** `'all'` for an Admin, and for an unrestricted Team Leader or Viewer. */
  readonly departmentIds: readonly string[] | 'all';
}

/** Whether the actor leads this particular department. */
export const leadsDepartment = (actor: DepartmentActor, departmentId: string): boolean => {
  if (actor.role === 'admin') {
    return true;
  }
  if (actor.role !== 'team_leader') {
    return false;
  }

  return actor.departmentIds === 'all' || actor.departmentIds.includes(departmentId);
};

/**
 * Whether the actor may change the brand's list of departments — create one,
 * delete one, or reorder them. Admin only, for the reason above.
 */
export const canShapeBrandDepartments = (actor: DepartmentActor): boolean => actor.role === 'admin';

/**
 * `null` when the action is allowed. Editing a department's contents — its
 * name, its default team, its teams and their members — is what a Team Leader
 * may do inside their own scope.
 */
export const departmentEditRefusal = (
  actor: DepartmentActor,
  departmentId: string,
): TicketingRefusal | null => (leadsDepartment(actor, departmentId) ? null : 'out-of-scope');

/**
 * `null` when the action is allowed. Used for create, delete and reorder, which
 * change which departments exist rather than what is in one.
 */
export const brandDepartmentsRefusal = (actor: DepartmentActor): TicketingRefusal | null =>
  canShapeBrandDepartments(actor) ? null : 'out-of-scope';

/** What the rules below need to know about somebody who might join a team. */
export interface TeamCandidate {
  readonly role: BrandRole;
  readonly departmentIds: readonly string[] | 'all';
}

/**
 * Whether this person could see the work a team in this department is given. A
 * member who cannot see the department's tickets would be assigned work that is
 * invisible to them (DOMAIN-RULES §1.2), so the picker and the write both
 * refuse it.
 *
 * An Admin — and anybody whose scope is `'all'` — reaches every department, so
 * they always pass this half.
 */
export const reachesDepartment = (member: TeamCandidate, departmentId: string): boolean =>
  member.role === 'admin' ||
  member.departmentIds === 'all' ||
  member.departmentIds.includes(departmentId);

/**
 * Whether `actor` may put this person on a team, or take them off one.
 *
 * DOMAIN-RULES §1.2: "Team membership follows the same ceiling as role changes:
 * a Team Leader may add only Agents and Viewers whose department scope covers
 * the team's department; Admins and other Team Leaders can be added to a team
 * only by an Admin." The list of roles a Team Leader may touch is
 * `staff-scope.ts`'s, imported rather than restated, so a fifth role is added
 * in one place.
 *
 * Removal is held to the same ceiling as addition. §1.2 words the rule around
 * adding, but a Team Leader who could take an Admin *off* a rota would be
 * reaching past the same line in the other direction — and from M1-07 that is
 * a way to change who gets assigned.
 */
export const canManageMember = (actor: DepartmentActor, member: TeamCandidate): boolean => {
  if (actor.role === 'admin') {
    return true;
  }
  if (actor.role !== 'team_leader') {
    return false;
  }

  return LED_ROLES.includes(member.role);
};

/**
 * Whether somebody may be put on a team in this department *by this actor*:
 * they have to reach the department, and be someone the actor may act on.
 *
 * The picker and the write share it, so the list never offers a person the
 * write would refuse.
 */
export const isEligibleMember = (
  actor: DepartmentActor,
  member: TeamCandidate,
  departmentId: string,
): boolean => canManageMember(actor, member) && reachesDepartment(member, departmentId);
