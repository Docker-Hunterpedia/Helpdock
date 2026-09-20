import type { TicketStatus as TicketStatusRow } from '@helpdock/db';
import { TicketLifecycleFailure } from './lifecycle/lifecycle-failure.js';
import {
  type LifecycleEvent,
  type TicketLifecycleFacts,
  transitionFor,
} from './lifecycle/transitions.js';

/**
 * The one place a `status_id` is decided.
 *
 * M1-02 left this as a seam with a comment saying what would fill it; M1-08 is
 * that filling. What it added is the transition table of DOMAIN-RULES §2.2
 * ({@link ./lifecycle/transitions.js transitions.ts}) in front of the two
 * things M1-02 already did — refusing a status that is not this brand's, and
 * keeping `closed_at` in step with the system state.
 *
 * The division of labour is worth stating once, because three files touch a
 * status change:
 *
 * | File | Decides |
 * |---|---|
 * | `lifecycle/transitions.ts` | What §2.2 says should happen, from the state and the event alone |
 * | this file | Which status row that lands on, and what it does to `closed_at` |
 * | `lifecycle/lifecycle.service.ts` | Which rows are written, which hooks fire, what is enqueued |
 *
 * Nothing here reads the database or the clock. `now` and the resolved status
 * rows are passed in, so every branch is testable as a pure function — which is
 * what lets `status-change.test.ts` assert the whole of §2.2 without a
 * container.
 */

/** Refused because the status does not belong to this brand, or does not exist. */
export class UnknownStatusError extends Error {
  readonly statusId: string;

  constructor(statusId: string) {
    super('No such status in this brand');
    this.name = 'UnknownStatusError';
    this.statusId = statusId;
  }
}

export interface StatusChange {
  /** The status the caller asked for, named even when nothing was found for it. */
  readonly requestedStatusId: string;
  /** The status row the ticket is in now. */
  readonly current: TicketStatusRow;
  /**
   * The row `requestedStatusId` resolved to, read through the tenant
   * transaction — so `undefined` means "not this brand's" as surely as it means
   * "does not exist", and the two are refused identically. A brand must not be
   * able to learn that another brand has a status by its id.
   */
  readonly next: TicketStatusRow | undefined;
  /** What `closed_at` is on the ticket today. */
  readonly closedAt: Date | null;
  /**
   * The two facts §2.2 checks before the table: whether this ticket is the
   * secondary of a merge, and whether it is soft-deleted.
   */
  readonly ticket: Pick<TicketLifecycleFacts, 'mergedIntoId' | 'deletedAt'>;
  /**
   * Which row of §2.2 this is. An agent picking a status from the workspace is
   * `agent.status`; the lifecycle service names the others when it drives a
   * transition itself.
   */
  readonly event: LifecycleEvent;
  /** Passed in rather than read, so the decision is testable without a clock. */
  readonly now: Date;
}

export interface StatusChangeResult {
  readonly statusId: string;
  readonly closedAt: Date | null;
  /** False when the ticket is already in that status: nothing is written, nothing is logged. */
  readonly changed: boolean;
  /**
   * True when this change took the ticket **into** a closed state. The caller
   * fires `onResolved` and, unless the status is excluded from reports,
   * `onClosedForCsat` (§2.2).
   *
   * False for a move between two closed statuses — Closed to Spam — because the
   * ticket has not been closed twice.
   */
  readonly closing: boolean;
  /**
   * True when this change took the ticket **out of** a closed state. The caller
   * fires `onReopened`, which is where §3.5's clocks restart.
   */
  readonly reopening: boolean;
}

/**
 * The status the ticket ends in, and what that does to `closed_at`.
 *
 * `closed_at` is set the first time a ticket enters a closed state and cleared
 * when it leaves one; a ticket moved between two closed statuses — Closed to
 * Spam — keeps the timestamp it already had, because it has not been closed
 * twice (DOMAIN-RULES §2.2, and §3.5 for what reopening does to the clocks).
 *
 * @throws {UnknownStatusError} when the status is not this brand's.
 * @throws {TicketLifecycleFailure} when §2.2 has no row for this event in this
 * state — a merged ticket, a deleted one, or a reopen of something that was
 * never closed.
 */
export const applyStatusChange = ({
  requestedStatusId,
  current,
  next,
  closedAt,
  ticket,
  event,
  now,
}: StatusChange): StatusChangeResult => {
  if (next === undefined) {
    throw new UnknownStatusError(requestedStatusId);
  }

  const outcome = transitionFor({ ...ticket, systemState: current.systemState }, event);
  if (outcome.kind === 'refused') {
    throw new TicketLifecycleFailure(outcome.reason);
  }

  if (next.id === current.id) {
    return { statusId: current.id, closedAt, changed: false, closing: false, reopening: false };
  }

  const wasClosed = current.systemState === 'closed';
  const closing = next.systemState === 'closed';

  return {
    statusId: next.id,
    closedAt: closing ? (closedAt ?? now) : null,
    changed: true,
    closing: closing && !wasClosed,
    reopening: wasClosed && !closing,
  };
};
