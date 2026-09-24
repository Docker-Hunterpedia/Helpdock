import type { DbTransaction } from '@helpdock/db';
import { type ActivityActor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { AssignedTicket, AssignmentRepository } from './assignment.repository.js';
import { type PickInput, pickAssignee } from './rotation.js';

/**
 * The half of M1-07 that runs in the worker: give a ticket to the next person
 * in its department's rotation, or take one away from somebody who can no
 * longer hold it.
 *
 * Both run inside the brand's system transaction the `outbox.event` consumer
 * opened (DOMAIN-RULES §1.4), so what they write commits with the job's
 * receipt: a redelivery finds the receipt, and a crash half-way rolls the
 * assignment back with it (§6). Both leave the two rows every ticket change
 * leaves — a `ticket_activity` entry and a `ticket.updated` outbox row — so
 * the thread says who picked the assignee and every open screen hears about
 * it.
 */

/** Who presence says is `online` in a brand now. `away` is not online (§12). */
export interface PresenceReader {
  online(brandId: string): Promise<ReadonlySet<string>>;
}

/**
 * The actor the activity log records. `system` rather than a person, because
 * no person chose the assignee; the id says which part of the system did.
 */
export const ASSIGNMENT_ACTOR: ActivityActor = {
  actorType: 'system',
  actorId: 'assignment',
  via: 'system',
};

/**
 * Why a ticket is being routed, which decides whose setting applies.
 *
 * - `routed`: a new ticket, one moved into the department, or one an offline
 *   agent was relieved of. The department's **mode** decides.
 * - `on_unassign`: the assignee lost access to it (DOMAIN-RULES §12). The
 *   department's **`on_unassign`** decides, and `round_robin` there runs the
 *   rotation even in a department whose mode is manual.
 */
export type AssignmentTrigger = 'routed' | 'on_unassign';

export type AutoAssignOutcome =
  | { readonly assigned: string }
  | { readonly skipped: 'not-found' | 'closed' | 'assigned' | 'manual' | 'nobody' };

export interface AutoAssignDeps {
  readonly repository: AssignmentRepository;
  readonly presence: PresenceReader;
}

export interface AutoAssignRequest {
  readonly brandId: string;
  readonly ticketId: string;
  readonly trigger: AssignmentTrigger;
  readonly now: Date;
}

/** The rotation a department runs for this trigger, or null for "leave it alone". */
const rotationFor = (
  department: { assignmentMode: PickInput['mode'] | 'manual'; onUnassign: string },
  trigger: AssignmentTrigger,
): PickInput['mode'] | null => {
  if (trigger === 'on_unassign') {
    if (department.onUnassign !== 'round_robin') {
      return null;
    }

    return department.assignmentMode === 'skill_based' ? 'skill_based' : 'round_robin';
  }

  return department.assignmentMode === 'manual' ? null : department.assignmentMode;
};

export const autoAssign = async (
  { repository, presence }: AutoAssignDeps,
  tx: DbTransaction,
  { brandId, ticketId, trigger, now }: AutoAssignRequest,
): Promise<AutoAssignOutcome> => {
  await repository.lockBrandRotation(tx, brandId);

  const ticket = await repository.ticketForAssignment(tx, ticketId);
  if (ticket === undefined) {
    return { skipped: 'not-found' };
  }
  // Spam, merged, closed and deleted tickets are never handed out: nobody is
  // going to answer them, and each would count against somebody's cap.
  if (ticket.deletedAt !== null || ticket.systemState === 'closed' || ticket.excludedFromReports) {
    return { skipped: 'closed' };
  }
  // Somebody got there first — a person, or an earlier delivery of this job.
  if (ticket.assigneeId !== null) {
    return { skipped: 'assigned' };
  }

  const department = await repository.department(tx, ticket.departmentId);
  const mode = department === undefined ? null : rotationFor(department, trigger);
  if (department === undefined || mode === null) {
    return { skipped: 'manual' };
  }

  const [candidates, online, openCounts, ticketTagIds] = await Promise.all([
    repository.candidates(tx, brandId, department.id),
    presence.online(brandId),
    repository.openCounts(tx, department.id),
    mode === 'skill_based' ? repository.ticketTagIds(tx, ticketId) : Promise.resolve([]),
  ]);

  const picked = pickAssignee({
    departmentId: department.id,
    mode,
    loadCap: department.loadCap,
    candidates,
    online,
    openCounts,
    ticketTagIds,
  });
  if (picked === null) {
    return { skipped: 'nobody' };
  }

  await repository.setAssignee(tx, ticketId, picked);
  await repository.markAssigned(tx, {
    brandId,
    departmentId: department.id,
    userId: picked,
    at: now,
  });
  await writeTicketActivity(tx, {
    brandId,
    ticketId,
    departmentId: department.id,
    actor: ASSIGNMENT_ACTOR,
    action: 'ticket.updated',
    from: { assigneeId: null },
    to: { assigneeId: picked, assignedBy: mode },
  });
  await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, {
    ticketId,
    departmentId: department.id,
  });

  return { assigned: picked };
};

/** Why an assignee was taken off a ticket, recorded on the activity row. */
export type UnassignReason = 'offline' | 'access_lost';

export const unassignTicket = async (
  repository: AssignmentRepository,
  tx: DbTransaction,
  {
    brandId,
    ticket,
    userId,
    reason,
  }: { brandId: string; ticket: AssignedTicket; userId: string; reason: UnassignReason },
): Promise<void> => {
  await repository.setAssignee(tx, ticket.id, null);
  await writeTicketActivity(tx, {
    brandId,
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    actor: ASSIGNMENT_ACTOR,
    action: 'ticket.updated',
    from: { assigneeId: userId },
    to: { assigneeId: null, reason },
  });
  await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, {
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
  });
};
