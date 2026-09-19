import type { BrandRole, TicketingRefusal } from '@helpdock/schemas';

/**
 * Who may change what about a brand's departments. It is
 * [DOMAIN-RULES §1.2](../../../../docs/planning/DOMAIN-RULES.md#12-scope-rules)
 * transcribed; when the two disagree, this file is wrong.
 *
 * | Role | Departments |
 * |---|---|
 * | Admin | Creates, renames, reorders and deletes every department in the brand |
 * | Team Leader | Edits the departments they lead — name, default team, teams and their members — and nothing else |
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

/**
 * Whether somebody with this role and scope may be put on a team in this
 * department. A member who cannot see the department's tickets would be
 * assigned work that is invisible to them (DOMAIN-RULES §1.2), so the picker
 * and the write both refuse it.
 *
 * An Admin — and anybody whose scope is `'all'` — reaches every department, so
 * they are always eligible.
 */
export const isEligibleMember = (
  member: { readonly role: BrandRole; readonly departmentIds: readonly string[] | 'all' },
  departmentId: string,
): boolean =>
  member.role === 'admin' ||
  member.departmentIds === 'all' ||
  member.departmentIds.includes(departmentId);
