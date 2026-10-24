import type { TicketSystemState } from '@helpdock/schemas';

/**
 * What a change to a status's system state does to the tickets already in it,
 * as a pure function of the two states (DOMAIN-RULES §2.2).
 *
 * The status row only carries the state; its tickets carry `closed_at`, and
 * the two have to agree: a live ticket in a closed-state status is closed and
 * one in an open-state status is not. Editing the state is therefore not a
 * relabel, and one dropdown must not become an unbounded mass action:
 *
 * - into `closed` it closes every live ticket in the status, after the person
 *   confirmed the number (`confirmCount`);
 * - out of `closed` it is refused while the status holds any live ticket, so
 *   nothing is reopened in bulk (the admin moves or merges them first).
 *
 * Between the three open-like states nothing is owed: `open`, `on_hold` and
 * `escalated` differ in nothing the clocks or `closed_at` read, and a change
 * of the status's `pauses_sla` flag re-syncs the clocks on its own (§3.2).
 */

/** Which side of the closed boundary this edit crosses, if it crosses one. */
export type StatusStateTransition = 'close' | 'reopen' | 'none';

export const statusStateTransitionFor = (
  before: TicketSystemState,
  after: TicketSystemState,
): StatusStateTransition => {
  if (before === after) {
    return 'none';
  }
  if (before === 'closed') {
    return 'reopen';
  }
  return after === 'closed' ? 'close' : 'none';
};

/** Whether a live ticket in a status of this state carries a `closed_at`. */
export const stateExpectsClosedAt = (state: TicketSystemState): boolean => state === 'closed';

/**
 * The state §2.2 reads a ticket's transitions from.
 *
 * It is the status's own state, with one exception: while a status-state close
 * is still working through its batch, a ticket in the now-closed status that
 * has not been reached has no `closed_at` — its clocks run and it was never
 * surveyed — so a reply on it behaves like a reply on an open ticket.
 *
 * The converse is deliberately not read: a ticket in an open status that has a
 * `closed_at` is real 1.0 data (deleting a status moves its tickets to the
 * default open status and leaves `closed_at`, `moveTicketsToStatus`), and it is
 * an open ticket.
 */
export const effectiveSystemState = (
  ticket: { readonly closedAt: Date | null },
  status: { readonly systemState: TicketSystemState },
): TicketSystemState =>
  ticket.closedAt === null && stateExpectsClosedAt(status.systemState)
    ? 'open'
    : status.systemState;
