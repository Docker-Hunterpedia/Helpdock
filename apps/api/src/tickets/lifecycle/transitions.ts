import type { TicketLifecycleRefusal, TicketSystemState } from '@helpdock/schemas';

/**
 * [DOMAIN-RULES §2.2](../../../../../docs/planning/DOMAIN-RULES.md#22-transitions)
 * as data.
 *
 * The table in that document has nine rows and is the whole of the ticket
 * lifecycle. It is transcribed here as one constant rather than spread across
 * the handlers that cause each event, because the property that matters — that
 * *every* state answers *every* event, and answers it the same way whoever asks
 * — is only checkable when the table is one value. `transitions.test.ts` holds
 * a second copy, typed out from the document rather than imported, and asserts
 * the two agree cell by cell.
 *
 * Nothing here touches the database, reads a clock, or knows what a status row
 * is. It decides *what should happen*; `lifecycle.service.ts` is what makes it
 * happen, and `reopen-policy.ts` answers the one cell that needs a brand
 * setting and a date.
 *
 * Two facts about a ticket sit outside the four system states and are checked
 * before the table, because they answer every event the same way:
 *
 * - a ticket with `merged_into_id` is the secondary of a merge, and its state
 *   belongs to the primary (§2.4) — M1-09 is what sets and clears it;
 * - a soft-deleted ticket is hidden from every view (§2.2), so nothing acts on
 *   it until it is restored or purged by retention (§11).
 */

/** What happened to a ticket. One per row of §2.2, in the document's order. */
export const LIFECYCLE_EVENTS = [
  'customer.reply',
  'agent.reply',
  'agent.status',
  'agent.close',
  'agent.reopen',
  'mark.spam',
  'merge',
  'soft.delete',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** The four of DOMAIN-RULES §2.1, in the order the document lists them. */
export const SYSTEM_STATES = ['open', 'on_hold', 'escalated', 'closed'] as const;

/**
 * What a transition asks the service to do.
 *
 * `to-default-open`, `to-awaiting-customer`, `to-spam` and `to-merged` name a
 * status by what it *is* rather than by an id, because which row plays each
 * part is the brand's choice and may be renamed at will
 * (`packages/db/src/ticket-statuses.ts`).
 */
export type TransitionOutcome =
  /** §2.2 row 1: the brand's default open status, and `awaiting_customer` cleared. */
  | { readonly kind: 'to-default-open'; readonly clearsAwaitingCustomer: true }
  /** §2.2 row 2, when the brand toggle is on. The toggle is read by the caller. */
  | { readonly kind: 'to-awaiting-customer' }
  /** §2.2 row 3: whatever the agent picked, which the caller has already resolved. */
  | { readonly kind: 'to-requested' }
  /** §2.2 row 4: `closed_at`, the resolution hook, and CSAT unless excluded. */
  | { readonly kind: 'close' }
  /** §2.2 row 5: governed by the reopen policy; see `reopen-policy.ts`. */
  | { readonly kind: 'reopen-policy' }
  /** §2.2 row 6: back to the default open status, with §3.5's clocks restarted. */
  | { readonly kind: 'reopen' }
  /** §2.2 row 7. M1-11 owns what else being spam means. */
  | { readonly kind: 'to-spam' }
  /** §2.2 row 8. M1-09 owns the rest of a merge. */
  | { readonly kind: 'to-merged' }
  /** §2.2 row 9: hidden from every view until retention purges it (§11). */
  | { readonly kind: 'soft-delete' }
  /** No row in §2.2 covers this, so it is refused rather than guessed at. */
  | { readonly kind: 'refused'; readonly reason: TicketLifecycleRefusal };

const CUSTOMER_REPLY_TO_OPEN: TransitionOutcome = {
  kind: 'to-default-open',
  clearsAwaitingCustomer: true,
};

const NOT_CLOSED: TransitionOutcome = { kind: 'refused', reason: 'ticket-not-closed' };

type TransitionTable = Readonly<
  Record<TicketSystemState, Readonly<Record<LifecycleEvent, TransitionOutcome>>>
>;

/**
 * Every system state against every event. Read it as §2.2 with the rows that
 * say "any" expanded, which is what makes the missing cells visible: an agent
 * reply only moves a ticket that is `open`, and a reopen only applies to
 * something that was closed.
 */
export const TRANSITIONS: TransitionTable = Object.freeze({
  open: Object.freeze<Record<LifecycleEvent, TransitionOutcome>>({
    'customer.reply': CUSTOMER_REPLY_TO_OPEN,
    // "`open` | Agent public reply, toggle on | Awaiting customer". Only `open`:
    // a ticket an agent replies to while it is escalated or on hold is already
    // somewhere deliberate, and §2.2 does not move it.
    'agent.reply': { kind: 'to-awaiting-customer' },
    'agent.status': { kind: 'to-requested' },
    'agent.close': { kind: 'close' },
    'agent.reopen': NOT_CLOSED,
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  }),
  on_hold: Object.freeze<Record<LifecycleEvent, TransitionOutcome>>({
    'customer.reply': CUSTOMER_REPLY_TO_OPEN,
    'agent.reply': { kind: 'to-requested' },
    'agent.status': { kind: 'to-requested' },
    'agent.close': { kind: 'close' },
    'agent.reopen': NOT_CLOSED,
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  }),
  escalated: Object.freeze<Record<LifecycleEvent, TransitionOutcome>>({
    'customer.reply': CUSTOMER_REPLY_TO_OPEN,
    'agent.reply': { kind: 'to-requested' },
    'agent.status': { kind: 'to-requested' },
    'agent.close': { kind: 'close' },
    'agent.reopen': NOT_CLOSED,
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  }),
  closed: Object.freeze<Record<LifecycleEvent, TransitionOutcome>>({
    // "`closed` | Customer reply | Governed by reopen policy, §2.3".
    'customer.reply': { kind: 'reopen-policy' },
    // An agent replying to a closed ticket does not reopen it by itself: §2.2
    // gives the agent a reopen of their own, and a reply that silently changed
    // the state would make "closed" mean nothing.
    'agent.reply': { kind: 'to-requested' },
    'agent.status': { kind: 'to-requested' },
    // Already closed. Moving between two closed statuses is `agent.status`, and
    // it keeps the `closed_at` it has (`status-change.ts`).
    'agent.close': { kind: 'to-requested' },
    'agent.reopen': { kind: 'reopen' },
    'mark.spam': { kind: 'to-spam' },
    merge: { kind: 'to-merged' },
    'soft.delete': { kind: 'soft-delete' },
  }),
});

/** What the table needs to know about the ticket beyond its system state. */
export interface TicketLifecycleFacts {
  readonly systemState: TicketSystemState;
  /** Set on the secondary of a merge (§2.4). M1-09 owns it. */
  readonly mergedIntoId: string | null;
  /** Set by the soft delete of §2.2. */
  readonly deletedAt: Date | null;
}

/**
 * The outcome for one event on one ticket.
 *
 * The two flags are checked first and refuse everything, including another
 * merge or another delete: re-merging a secondary would move a ticket whose
 * state the primary owns, and §2.4 makes unmerge — M1-09's — the only way back.
 */
export const transitionFor = (
  ticket: TicketLifecycleFacts,
  event: LifecycleEvent,
): TransitionOutcome => {
  if (ticket.deletedAt !== null) {
    return { kind: 'refused', reason: 'ticket-deleted' };
  }
  if (ticket.mergedIntoId !== null) {
    return { kind: 'refused', reason: 'ticket-merged' };
  }

  return TRANSITIONS[ticket.systemState][event];
};
