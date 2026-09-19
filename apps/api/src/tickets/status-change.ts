import type { TicketStatus as TicketStatusRow } from '@helpdock/db';

/**
 * The seam M1-08 replaces.
 *
 * DOMAIN-RULES §2.2 is a transition table: a customer reply reopens, an agent
 * reply moves the ticket to Awaiting customer when the brand toggle is on, a
 * close stops the resolution clock and schedules CSAT, a reply to a closed
 * ticket is governed by the reopen policy. None of that is M1-02's to decide —
 * it needs the brand toggles, the SLA clocks and the reopen policy, which
 * arrive with M1-08 and M3-02.
 *
 * What M1-02 owes the rest of M1 is the *shape*: one function that every status
 * change goes through, so that when the table arrives there is exactly one
 * place to put it and no caller that wrote `status_id` directly. Today it does
 * the two things that would otherwise leave a column lying: it refuses a status
 * that is not this brand's, and it keeps `closed_at` in step with the system
 * state, because a ticket that is closed without `closed_at` is a ticket no
 * report can measure.
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
  /** Passed in rather than read, so the decision is testable without a clock. */
  readonly now: Date;
}

export interface StatusChangeResult {
  readonly statusId: string;
  readonly closedAt: Date | null;
  /** False when the ticket is already in that status: nothing is written, nothing is logged. */
  readonly changed: boolean;
}

/**
 * The status the ticket ends in, and what that does to `closed_at`.
 *
 * `closed_at` is set the first time a ticket enters a closed state and cleared
 * when it leaves one; a ticket moved between two closed statuses — Closed to
 * Spam — keeps the timestamp it already had, because it has not been closed
 * twice (DOMAIN-RULES §2.2, and §3.5 for what reopening does to the clocks).
 */
export const applyStatusChange = ({
  requestedStatusId,
  current,
  next,
  closedAt,
  now,
}: StatusChange): StatusChangeResult => {
  if (next === undefined) {
    throw new UnknownStatusError(requestedStatusId);
  }

  if (next.id === current.id) {
    return { statusId: current.id, closedAt, changed: false };
  }

  const closing = next.systemState === 'closed';

  return {
    statusId: next.id,
    closedAt: closing ? (closedAt ?? now) : null,
    changed: true,
  };
};
