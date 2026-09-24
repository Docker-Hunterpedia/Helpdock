import type { DbTransaction } from '@helpdock/db';
import type { TicketingRefusal } from '@helpdock/schemas';
import type { Principal } from '../auth/principal.js';
import type { AssignmentRepository } from './assignment.repository.js';
import { canWorkDepartment, mayAssignTo } from './rotation.js';

/**
 * What a ticket write asks of M1-07: may this person hold this ticket, and
 * does this department route tickets by itself.
 *
 * Functions over the request's transaction rather than a service, the way
 * `ticketing/ticket-tags.ts` serves the ticket module: `TicketsService` needs
 * two answers, not a second module's lifecycle.
 */

/**
 * Why `assigneeId` may not hold a ticket in `departmentId`, or null when it
 * may. The load cap is deliberately not consulted: a person may hand a ticket
 * to an agent at cap, which is what the cap's own copy promises.
 *
 * - `not-member`: no role in this brand at all — the caller's 400, as before.
 * - `not-eligible`: a role that does not reach the department, a Viewer, or a
 *   deactivated account. They could never open the ticket (DOMAIN-RULES §1.2).
 * - `assignee-above-actor`: a non-Admin handing work to an Admin (§1.2).
 */
export const assigneeRefusal = async (
  repository: AssignmentRepository,
  tx: DbTransaction,
  {
    brandId,
    principal,
    assigneeId,
    departmentId,
  }: { brandId: string; principal: Principal; assigneeId: string; departmentId: string },
): Promise<'not-member' | TicketingRefusal | null> => {
  const assignee = await repository.member(tx, brandId, assigneeId);
  if (assignee === undefined) {
    return 'not-member';
  }
  if (!canWorkDepartment(assignee, departmentId)) {
    return 'not-eligible';
  }

  // An API key or a worker has no role to hold a ceiling against; only a
  // person does.
  const actorRole = principal.type === 'staff' ? principal.brands[brandId]?.role : undefined;
  if (actorRole !== undefined && !mayAssignTo(actorRole, assignee.role)) {
    return 'assignee-above-actor';
  }

  return null;
};

/** Whether the person may still work tickets in a department they are being moved into. */
export const worksDepartment = async (
  repository: AssignmentRepository,
  tx: DbTransaction,
  { brandId, userId, departmentId }: { brandId: string; userId: string; departmentId: string },
): Promise<boolean> => {
  const member = await repository.member(tx, brandId, userId);

  return member !== undefined && canWorkDepartment(member, departmentId);
};

/** Whether an unassigned ticket arriving in this department is handed out by the rotation. */
export const routesAutomatically = async (
  repository: AssignmentRepository,
  tx: DbTransaction,
  departmentId: string,
): Promise<boolean> => {
  const department = await repository.department(tx, departmentId);

  return department !== undefined && department.assignmentMode !== 'manual';
};
