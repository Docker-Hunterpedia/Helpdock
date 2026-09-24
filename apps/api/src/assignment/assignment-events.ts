import type { DbTransaction } from '@helpdock/db';
import {
  type AssignmentOfflineUnassignPayload,
  enqueueOutbox,
  type JobHandler,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import type { PresenceStatus } from '@helpdock/schemas';
import { z } from 'zod';
import { type AutoAssignDeps, autoAssign, unassignTicket } from './auto-assign.js';
import { canWorkDepartment } from './rotation.js';

/**
 * M1-07's side effects, the long way round DOMAIN-RULES §6 requires: a request
 * or a presence change writes an outbox row in its own transaction, and the
 * worker does the work in the brand's system transaction.
 *
 * | Event | Written by | Handler does |
 * |---|---|---|
 * | `assignment.requested` | ticket created, moved, or unassigned by a rule | the rotation picks an assignee |
 * | `assignment.access_changed` | staff deactivated, removed, or re-scoped | unassigns what they can no longer work, then applies `on_unassign` |
 * | `assignment.staff_offline` | presence: somebody's last socket in a brand went | schedules `assignment.offline_unassign` per department that asks for it |
 *
 * Nothing here enqueues a BullMQ job from a request. The one `queue.add` is in
 * the `staff_offline` handler, which runs after the outbox row committed, with
 * a job id derived from the departure so a redelivery adds nothing new — the
 * same shape `attachment.uploaded` uses for `media.process`.
 */

export const ASSIGNMENT_EVENTS = {
  requested: 'assignment.requested',
  accessChanged: 'assignment.access_changed',
  staffOffline: 'assignment.staff_offline',
} as const;

export const assignmentRequestedPayloadSchema = z.object({
  ticketId: z.uuid(),
  trigger: z.enum(['routed', 'on_unassign']),
});
export type AssignmentRequestedPayload = z.infer<typeof assignmentRequestedPayloadSchema>;

export const accessChangedPayloadSchema = z.object({ userId: z.uuid() });

export const staffOfflinePayloadSchema = z.object({
  userId: z.uuid(),
  since: z.iso.datetime(),
});
export type StaffOfflinePayload = z.infer<typeof staffOfflinePayloadSchema>;

export const requestAutoAssign = (
  tx: DbTransaction,
  brandId: string,
  payload: AssignmentRequestedPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: ASSIGNMENT_EVENTS.requested,
    payload: assignmentRequestedPayloadSchema.parse(payload),
  });

export const enqueueAccessChanged = (
  tx: DbTransaction,
  brandId: string,
  userId: string,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: ASSIGNMENT_EVENTS.accessChanged,
    payload: accessChangedPayloadSchema.parse({ userId }),
  });

export const enqueueStaffOffline = (
  tx: DbTransaction,
  brandId: string,
  payload: StaffOfflinePayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: ASSIGNMENT_EVENTS.staffOffline,
    payload: staffOfflinePayloadSchema.parse(payload),
  });

/** What the worker needs of presence beyond "who is online". */
export interface PresenceLookup {
  statusOf(brandId: string, userId: string): Promise<PresenceStatus>;
}

/**
 * The latest departure per person per brand. A timer from an earlier departure
 * that fires after a later one has started is stale, and this is how it knows.
 */
export interface OfflineSinceStore {
  set(brandId: string, userId: string, since: string): Promise<void>;
  get(brandId: string, userId: string): Promise<string | null>;
}

export interface OfflineUnassignQueue {
  add(options: {
    jobId: string;
    delayMs: number;
    payload: AssignmentOfflineUnassignPayload;
  }): Promise<void>;
}

/** What the three outbox handlers need. */
export interface AssignmentHandlerDeps extends AutoAssignDeps {
  readonly offlineSince: OfflineSinceStore;
  readonly queue: OfflineUnassignQueue;
  readonly now?: () => Date;
}

/** What the delayed `assignment.offline_unassign` job needs. */
export interface OfflineUnassignDeps extends AutoAssignDeps {
  readonly lookup: PresenceLookup;
  readonly offlineSince: OfflineSinceStore;
  readonly now?: () => Date;
}

const clock = (deps: { now?: () => Date }): Date => deps.now?.() ?? new Date();

export const createAssignmentRequestedHandler =
  (deps: AutoAssignDeps & { now?: () => Date }): OutboxEventHandler =>
  async ({ brandId, payload, tx, log }: OutboxEventContext): Promise<void> => {
    const { ticketId, trigger } = assignmentRequestedPayloadSchema.parse(payload);
    const outcome = await autoAssign(deps, tx, { brandId, ticketId, trigger, now: clock(deps) });

    log.info({ brandId, ticketId, trigger, ...outcome }, 'assignment requested');
  };

/**
 * DOMAIN-RULES §12: "tickets they can no longer see are unassigned per
 * department setting `on_unassign`". What they can no longer see is decided
 * from their membership *now*, so the same handler serves a deactivation, a
 * removal from the brand and a narrowed scope, and does nothing for a widened
 * one.
 */
export const createAccessChangedHandler =
  (deps: AutoAssignDeps & { now?: () => Date }): OutboxEventHandler =>
  async ({ brandId, payload, tx }: OutboxEventContext): Promise<void> => {
    const { userId } = accessChangedPayloadSchema.parse(payload);
    const member = await deps.repository.member(tx, brandId, userId);
    const tickets = await deps.repository.openTicketsOf(tx, brandId, userId);

    for (const ticket of tickets) {
      if (member !== undefined && canWorkDepartment(member, ticket.departmentId)) {
        continue;
      }

      await unassignTicket(deps.repository, tx, {
        brandId,
        ticket,
        userId,
        reason: 'access_lost',
      });
      await autoAssign(deps, tx, {
        brandId,
        ticketId: ticket.id,
        trigger: 'on_unassign',
        now: clock(deps),
      });
    }
  };

/**
 * Starts the fifteen-minute clock (or whatever the department says) in every
 * department that asks for it and where the person holds open tickets. One job
 * per department, because each department has its own minutes.
 */
export const createStaffOfflineHandler =
  (deps: AssignmentHandlerDeps): OutboxEventHandler =>
  async ({ brandId, payload, tx }: OutboxEventContext): Promise<void> => {
    const { userId, since } = staffOfflinePayloadSchema.parse(payload);
    await deps.offlineSince.set(brandId, userId, since);

    const [departments, tickets] = await Promise.all([
      deps.repository.departments(tx, brandId),
      deps.repository.openTicketsOf(tx, brandId, userId),
    ]);
    const holding = new Set(tickets.map((ticket) => ticket.departmentId));
    const elapsed = clock(deps).getTime() - Date.parse(since);

    for (const department of departments) {
      if (!department.autoUnassignOffline || !holding.has(department.id)) {
        continue;
      }

      await deps.queue.add({
        // BullMQ refuses a custom id with a colon in it.
        jobId: `offline-unassign-${userId}-${department.id}-${Date.parse(since)}`,
        delayMs: Math.max(0, department.autoUnassignAfterMinutes * 60_000 - elapsed),
        payload: { brandId, userId, departmentId: department.id, since },
      });
    }
  };

/**
 * The timer firing. It acts only if the person is still offline *from the
 * same departure* and the department still asks for it; anything else means
 * the world moved on while the job waited.
 *
 * Business hours are M3's (DOMAIN-RULES §12 says "never during business hours
 * closed periods"). No department has any before then, so every period is an
 * open one; M3 adds the check here and reschedules to the next opening.
 */
export const createOfflineUnassignProcessor =
  (deps: OfflineUnassignDeps): JobHandler<AssignmentOfflineUnassignPayload> =>
  async ({ payload, tx, log }): Promise<void> => {
    const { brandId, userId, departmentId, since } = payload;

    if ((await deps.lookup.statusOf(brandId, userId)) !== 'offline') {
      log.info({ brandId, userId, departmentId }, 'offline unassign skipped: back online');
      return;
    }
    if ((await deps.offlineSince.get(brandId, userId)) !== since) {
      log.info({ brandId, userId, departmentId }, 'offline unassign skipped: a later departure');
      return;
    }

    const department = await deps.repository.department(tx, departmentId);
    if (department === undefined || !department.autoUnassignOffline) {
      return;
    }

    const tickets = await deps.repository.openTicketsOf(tx, brandId, userId, departmentId);
    for (const ticket of tickets) {
      await unassignTicket(deps.repository, tx, { brandId, ticket, userId, reason: 'offline' });
      await autoAssign(deps, tx, {
        brandId,
        ticketId: ticket.id,
        trigger: 'routed',
        now: clock(deps),
      });
    }
  };

/**
 * Called by the worker's start-up, before the `outbox.event` consumer exists,
 * for the reason `ticket-events.ts` gives.
 */
export const registerAssignmentEventHandlers = (deps: AssignmentHandlerDeps): void => {
  registerEventHandler(ASSIGNMENT_EVENTS.requested, createAssignmentRequestedHandler(deps));
  registerEventHandler(ASSIGNMENT_EVENTS.accessChanged, createAccessChangedHandler(deps));
  registerEventHandler(ASSIGNMENT_EVENTS.staffOffline, createStaffOfflineHandler(deps));
};
