import { type DbTransaction, ticketActivity } from '@helpdock/db';
import type { ActivityVia } from '@helpdock/schemas';
import type { Principal } from '../auth/principal.js';

/**
 * "Activity log: every state change with who/when/via what (UI, rule, API, AI)"
 * — REQUIREMENTS §4.1.
 *
 * The row is written through the caller's transaction, so a handler that throws
 * after it rolls the entry back with the change it described. An activity log
 * that records things that did not happen is worse than none, which is the same
 * reason `staff/audit.ts` gives for `audit_log`.
 *
 * `departmentId` is passed by the caller and then overwritten by the
 * `ticket_activity_department` trigger with the parent ticket's own. The caller
 * passes what it read; the trigger makes it true.
 */

/**
 * The verbs M1-02 and M1-03 write, and the five M1-08 adds for the transitions
 * of DOMAIN-RULES §2.2. M1-07, M1-09 and M1-11 add their own beside them.
 *
 * A transition writes `ticket.status.changed` *and*, where §2.2 names the
 * event, one of the five: closing a ticket is a status change and a close, and
 * a reader of the thread wants the second word. A continuation writes
 * `ticket.continued` on both tickets, because each is half of the answer to
 * "where did this conversation go?".
 */
/** The verbs M1-02, M1-03, M1-06 and M1-08 write. M1-07 to M1-11 add their own beside them. */
export type TicketActivityAction =
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.status.changed'
  | 'ticket.replied'
  | 'ticket.note_added'
  | 'ticket.closed'
  | 'ticket.reopened'
  | 'ticket.continued'
  | 'ticket.deleted'
  | 'ticket.escalated'
  /** M1-06. Its own verb rather than `ticket.updated`, because the thread draws chips. */
  | 'ticket.tags.changed'
  /** M1-11. Beside `ticket.status.changed`, as `ticket.closed` is, so the log says why. */
  | 'ticket.marked_spam'
  | 'ticket.unmarked_spam';

/**
 * The actor behind a change, in the three words the activity log records.
 *
 * `via` is *how* the change was made, not who made it: the same person is `ui`
 * through the admin and `api` through a key. M3-03's rules pass `rule` with an
 * actor id of `rule:<id>`, and M7's AI passes `ai`; deriving the rest from the
 * principal keeps the two from drifting, because nothing else in a request
 * knows the difference.
 */
export interface ActivityActor {
  readonly actorType: 'staff' | 'visitor' | 'apikey' | 'system';
  readonly actorId: string;
  readonly via: ActivityVia;
}

export const activityActorFor = (principal: Principal): ActivityActor => {
  switch (principal.type) {
    case 'staff':
      return { actorType: 'staff', actorId: principal.id, via: 'ui' };
    case 'apikey':
      return { actorType: 'apikey', actorId: principal.id, via: 'api' };
    case 'visitor':
      return { actorType: 'visitor', actorId: principal.id, via: 'ui' };
    case 'system':
      return { actorType: 'system', actorId: principal.jobId, via: 'system' };
  }
};

export interface TicketActivityInput {
  readonly brandId: string;
  readonly ticketId: string;
  /** The ticket's department, as the caller read it. The trigger confirms it. */
  readonly departmentId: string;
  readonly actor: ActivityActor;
  readonly action: TicketActivityAction;
  /** What moved, as `{ field: value }` on each side. Absent for a creation. */
  readonly from?: Record<string, unknown>;
  readonly to?: Record<string, unknown>;
}

export const writeTicketActivity = async (
  tx: DbTransaction,
  { brandId, ticketId, departmentId, actor, action, from, to }: TicketActivityInput,
): Promise<void> => {
  await tx.insert(ticketActivity).values({
    brandId,
    ticketId,
    departmentId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action,
    from: from ?? null,
    to: to ?? null,
    via: actor.via,
  });
};
