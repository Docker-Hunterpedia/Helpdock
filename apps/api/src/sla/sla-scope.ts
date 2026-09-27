import type {
  BusinessHours,
  BusinessHoursUpdateRequest,
  SlaCondition,
  TicketingRefusal,
} from '@helpdock/schemas';
import { type DepartmentActor, leadsDepartment } from '../brands/department-scope.js';

/**
 * Who may change what on the Business hours and SLAs tabs. DOMAIN-RULES §1.2
 * gives a Team Leader "departments they lead: … SLAs" and keeps "everything in
 * the brand" — its time zone, its own hours, the order policies are tried in —
 * with the Admin.
 *
 * The line is drawn so that a Team Leader's change can only move clocks on
 * tickets they can see: a department's own hours and holidays, and a policy
 * that applies only to departments they lead. That is also what makes the
 * recompute after a save complete, because it runs under their own scope.
 */

const isAdmin = (actor: DepartmentActor): boolean => actor.role === 'admin';

const sameHours = (a: BusinessHours | null, b: BusinessHours | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** `null` when the save is allowed. */
export const hoursUpdateRefusal = (
  actor: DepartmentActor,
  current: {
    readonly brand: BusinessHours;
    readonly overrides: ReadonlyMap<string, BusinessHours>;
  },
  request: BusinessHoursUpdateRequest,
): TicketingRefusal | null => {
  if (isAdmin(actor)) {
    return null;
  }
  if (!sameHours(current.brand, request.brand)) {
    return 'out-of-scope';
  }

  const moved = request.departments.filter(
    ({ departmentId, override }) =>
      !sameHours(current.overrides.get(departmentId) ?? null, override),
  );

  return moved.every(({ departmentId }) => leadsDepartment(actor, departmentId))
    ? null
    : 'out-of-scope';
};

/** A holiday for every department is the brand's; one department's is its leader's. */
export const holidayRefusal = (
  actor: DepartmentActor,
  departmentId: string | null,
): TicketingRefusal | null => {
  if (departmentId === null) {
    return isAdmin(actor) ? null : 'out-of-scope';
  }

  return leadsDepartment(actor, departmentId) ? null : 'out-of-scope';
};

/**
 * A Team Leader may create, edit or delete a policy that applies only to
 * departments they lead — "Department is any of" with every value theirs. A
 * policy with no department condition, or a "none of" one, reaches
 * departments they do not lead, so it is the Admin's.
 */
export const policyRefusal = (
  actor: DepartmentActor,
  ...versions: readonly (readonly SlaCondition[])[]
): TicketingRefusal | null => {
  if (isAdmin(actor)) {
    return null;
  }

  const confined = versions.every((conditions) => {
    const department = conditions.find((condition) => condition.field === 'department');
    return (
      department !== undefined &&
      department.operator === 'any' &&
      department.values.every((departmentId) => leadsDepartment(actor, departmentId))
    );
  });

  return confined ? null : 'out-of-scope';
};

/** The order policies are tried in decides every ticket in the brand. */
export const reorderRefusal = (actor: DepartmentActor): TicketingRefusal | null =>
  isAdmin(actor) ? null : 'out-of-scope';
