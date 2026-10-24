import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { SNOOZE_MAX_MS, SNOOZE_MIN_MS, type TicketLifecycleRefusal } from '@helpdock/schemas';
import { effectiveSystemState } from '../lifecycle/status-state.js';
import { transitionFor } from '../lifecycle/transitions.js';
import { type ActivityActor, writeTicketActivity } from '../ticket-activity.js';
import { enqueueTicketSnoozed } from './snooze-events.js';
import { snoozeValues } from './snooze-wake.js';

/**
 * The one place a snooze is decided and recorded (M14-02, #368). The Snooze
 * menu and `PATCH` go through it from `TicketsService`, and a rule's or a
 * macro's `snooze` action through it from the rules engine and the macro run,
 * so the bounds, the transition and the columns cannot drift between writers.
 */

export type SnoozePlan =
  | {
      readonly kind: 'planned';
      /** The snooze columns, beside the status move they come with. */
      readonly values: ReturnType<typeof snoozeValues>;
      /** Whether the ticket is moving into Snoozed, or was in it already. */
      readonly statusChanged: boolean;
    }
  | { readonly kind: 'refused'; readonly reason: 'out-of-bounds' }
  | { readonly kind: 'refused'; readonly reason: 'no-snoozed-status' }
  | {
      readonly kind: 'refused';
      readonly reason: 'transition';
      readonly refusal: TicketLifecycleRefusal;
    };

export interface SnoozeRequest {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
  /** The brand's Snoozed status, or `undefined` when it was deleted. */
  readonly snoozed: TicketStatusRow | undefined;
  readonly until: Date;
  readonly now: Date;
  /** The person who snoozed, or `null` for a rule. */
  readonly snoozedBy: string | null;
}

/** Between 5 minutes and 90 days ahead, as a person's `PATCH` has always been held to. */
export const snoozeWithinBounds = (until: Date, now: Date): boolean => {
  const ahead = until.getTime() - now.getTime();

  return ahead >= SNOOZE_MIN_MS && ahead <= SNOOZE_MAX_MS;
};

export const planSnooze = ({
  ticket,
  status,
  snoozed,
  until,
  now,
  snoozedBy,
}: SnoozeRequest): SnoozePlan => {
  if (!snoozeWithinBounds(until, now)) {
    return { kind: 'refused', reason: 'out-of-bounds' };
  }

  const outcome = transitionFor(
    { ...ticket, systemState: effectiveSystemState(ticket, status) },
    'agent.snooze',
  );
  if (outcome.kind === 'refused') {
    return { kind: 'refused', reason: 'transition', refusal: outcome.reason };
  }
  if (snoozed === undefined) {
    return { kind: 'refused', reason: 'no-snoozed-status' };
  }

  return {
    kind: 'planned',
    values: snoozeValues({ ticket, snoozedStatusId: snoozed.id, until, snoozedBy }),
    statusChanged: snoozed.id !== status.id,
  };
};

/**
 * `ticket.snoozed`: the activity row and the outbox event whose consumer adds
 * the wake timer. Written once the ticket row carries the new snooze.
 */
export const recordSnooze = async (
  tx: DbTransaction,
  change: {
    readonly brandId: string;
    readonly actor: ActivityActor;
    readonly before: TicketRow;
    readonly after: TicketRow;
  },
): Promise<void> => {
  const { brandId, actor, before, after } = change;
  if (after.snoozedUntil === null) {
    return;
  }

  await writeTicketActivity(tx, {
    brandId,
    ticketId: after.id,
    departmentId: after.departmentId,
    actor,
    action: 'ticket.snoozed',
    from: { snoozedUntil: before.snoozedUntil?.toISOString() ?? null },
    to: {
      snoozedUntil: after.snoozedUntil.toISOString(),
      resumeStatusId: after.snoozeResumeStatusId,
    },
  });
  await enqueueTicketSnoozed(tx, brandId, {
    ticketId: after.id,
    departmentId: after.departmentId,
    version: after.snoozeVersion,
    snoozedUntil: after.snoozedUntil.toISOString(),
  });
};
