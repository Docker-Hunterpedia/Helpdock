import {
  type DbTransaction,
  type NewTicket,
  type Ticket as TicketRow,
  type TicketStatus as TicketStatusRow,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import { eq } from 'drizzle-orm';
import { TicketLifecycleRepository } from '../lifecycle/lifecycle.repository.js';
import { type ActivityActor, writeTicketActivity } from '../ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../ticket-events.js';
import { enqueueSnoozeEnded } from './snooze-events.js';

/**
 * Snooze as data, and the one function that wakes a ticket by time, by an SLA
 * step or by hand (DOMAIN-RULES §2.1, §2.2, M14-02).
 *
 * The other wakes need no function of their own. A customer reply, a status
 * change, a close, a merge and a spam mark all move `status_id`, and the
 * `tickets_snooze_guard` trigger clears the snooze columns on any such move, so
 * no writer can forget. What they add is the `ticket.woke` activity row, which
 * {@link writeWokeActivity} writes with the reason.
 */

export const SNOOZED_SYSTEM_KEY = 'snoozed';

/** Why a snooze ended, as the activity row records it (`ticket.woke`, `to.reason`). */
export type WakeReason = 'time' | 'customer_reply' | 'sla' | 'status_changed' | 'manual';

export const isSnoozedStatus = (status: Pick<TicketStatusRow, 'systemKey'>): boolean =>
  status.systemKey === SNOOZED_SYSTEM_KEY;

/** What a snooze writes to the ticket row, beyond the status. */
export const snoozeValues = (input: {
  readonly ticket: Pick<TicketRow, 'statusId' | 'snoozeResumeStatusId' | 'snoozedUntil'>;
  readonly snoozedStatusId: string;
  readonly until: Date;
  readonly snoozedBy: string | null;
}): Pick<NewTicket, 'statusId' | 'snoozedUntil' | 'snoozedBy' | 'snoozeResumeStatusId'> => ({
  statusId: input.snoozedStatusId,
  snoozedUntil: input.until,
  snoozedBy: input.snoozedBy,
  // Snoozing again keeps the status the ticket had before the first snooze.
  snoozeResumeStatusId:
    input.ticket.snoozedUntil === null ? input.ticket.statusId : input.ticket.snoozeResumeStatusId,
});

/** What a wake writes beside the status; the trigger would clear it anyway. */
export const WAKE_VALUES = {
  snoozedUntil: null,
  snoozedBy: null,
  snoozeResumeStatusId: null,
} as const;

/**
 * Where a ticket goes when it wakes by time, by an SLA step or by hand: the
 * status before the snooze if it still exists and is open-like, else the
 * brand's default open status (§2.2). A closed status is never a place to wake
 * to — it cannot be the status before a snooze, but it can be what a brand
 * changed that status into.
 */
export const wakeStatusFor = async (
  tx: DbTransaction,
  resumeStatusId: string | null,
): Promise<TicketStatusRow | undefined> => {
  if (resumeStatusId !== null) {
    const [resume] = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.id, resumeStatusId))
      .limit(1);
    if (resume !== undefined && resume.systemState !== 'closed' && !isSnoozedStatus(resume)) {
      return resume;
    }
  }

  const open = await new TicketLifecycleRepository().defaultOpenStatus(tx);

  return open;
};

export interface WokeActivity {
  readonly brandId: string;
  readonly ticket: Pick<TicketRow, 'id' | 'departmentId' | 'snoozedUntil'>;
  readonly actor: ActivityActor;
  readonly reason: WakeReason;
  /** The status the ticket woke into. */
  readonly statusId: string;
}

/** `ticket.woke`: the snooze that ended, when it was due, and why it ended. */
export const writeWokeActivity = (tx: DbTransaction, input: WokeActivity): Promise<void> =>
  writeTicketActivity(tx, {
    brandId: input.brandId,
    ticketId: input.ticket.id,
    departmentId: input.ticket.departmentId,
    actor: input.actor,
    action: 'ticket.woke',
    from: { snoozedUntil: input.ticket.snoozedUntil?.toISOString() ?? null },
    to: { statusId: input.statusId, reason: input.reason },
  });

const SYSTEM_ACTORS = {
  time: { actorType: 'system', actorId: 'snooze', via: 'system' },
  sla: { actorType: 'system', actorId: 'sla', via: 'system' },
} as const satisfies Record<'time' | 'sla', ActivityActor>;

export interface WakeResult {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
}

/**
 * Wakes a snoozed ticket because its time came or an SLA step fired. The
 * caller holds the ticket's row lock and has checked it is still snoozed.
 *
 * It writes the ticket, `ticket.status.changed` (so the status webhook fires)
 * and `ticket.woke`, tells the screens, and writes `ticket.snooze_ended` for
 * the notification. The clocks are the caller's: `sla.sync` follows, as it does
 * after any status change (§3.2). Returns `undefined` when the brand has no
 * status to wake into, which a seeded brand never lacks.
 */
export const wakeTicket = async (
  tx: DbTransaction,
  input: { readonly ticket: TicketRow; readonly cause: 'time' | 'sla'; readonly now: Date },
): Promise<WakeResult | undefined> => {
  const { ticket, cause, now } = input;
  const target = await wakeStatusFor(tx, ticket.snoozeResumeStatusId);
  if (target === undefined) {
    return undefined;
  }

  const [updated] = await tx
    .update(tickets)
    .set({ statusId: target.id, ...WAKE_VALUES, updatedAt: now })
    .where(eq(tickets.id, ticket.id))
    .returning();
  if (updated === undefined) {
    return undefined;
  }

  const actor = SYSTEM_ACTORS[cause];
  await writeTicketActivity(tx, {
    brandId: ticket.brandId,
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    actor,
    action: 'ticket.status.changed',
    from: { statusId: ticket.statusId },
    to: { statusId: target.id },
  });
  await writeWokeActivity(tx, {
    brandId: ticket.brandId,
    ticket,
    actor,
    reason: cause,
    statusId: target.id,
  });
  await enqueueSnoozeEnded(tx, ticket.brandId, {
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    cause,
    snoozedBy: ticket.snoozedBy,
  });
  await enqueueTicketEvent(tx, ticket.brandId, TICKET_EVENTS.updated, {
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    changes: ['status'],
    wokeBy: cause,
  });

  return { ticket: updated, status: target };
};
