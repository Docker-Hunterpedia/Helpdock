import type { Ticket, TicketList } from '@helpdock/schemas';
import type { TicketQuery } from './api.js';

/**
 * The four views the sidebar offers before M1-05 lets anybody save one.
 *
 * Each is a **query plus, where the api cannot answer it, a predicate**. Three
 * of them are pure filters `GET /tickets` already understands, so the server
 * narrows them and the browser counts what comes back. "Overdue" is not: the
 * list has no filter on `first_response_due_at` or `resolution_due_at`, so it
 * asks for everything still open and decides in the browser. When M1-05 builds
 * saved views on the server, that predicate is the one thing it has to replace;
 * the other three become rows in a table.
 *
 * `systemState` rather than a status id, because a brand renames its statuses
 * and a view that named one would break on the rename (DOMAIN-RULES §2.1).
 */

export const TICKET_VIEW_KEYS = ['myOpen', 'unassigned', 'overdue', 'escalated'] as const;
export type TicketViewKey = (typeof TICKET_VIEW_KEYS)[number];

/** Everything that is not closed. What "open" means to a person at a desk. */
const LIVE_STATES = ['open', 'on_hold', 'escalated'] as const;

export interface TicketView {
  readonly key: TicketViewKey;
  /** What the api is asked for. */
  query(viewerId: string): TicketQuery;
  /**
   * Applied to what came back, for the part no filter expresses. Absent means
   * the query is the whole view.
   */
  readonly predicate?: (ticket: Ticket, now: number) => boolean;
}

/** Overdue: a clock that has already run out on a ticket nobody has closed. */
export const isOverdue = (ticket: Ticket, now: number): boolean => {
  if (ticket.status.systemState === 'closed') {
    return false;
  }

  // A paused clock is not running, so it cannot have run out while paused
  // (DOMAIN-RULES §3): "Awaiting customer" is waiting, not late.
  if (ticket.status.pausesSla) {
    return false;
  }

  const due = [ticket.firstResponseDueAt, ticket.resolutionDueAt].filter(
    (value): value is string => value !== null,
  );

  return ticket.slaBreached || due.some((value) => Date.parse(value) < now);
};

export const TICKET_VIEWS: Readonly<Record<TicketViewKey, TicketView>> = {
  myOpen: {
    key: 'myOpen',
    query: (viewerId) => ({ assigneeId: [viewerId], systemState: [...LIVE_STATES] }),
  },
  unassigned: {
    key: 'unassigned',
    query: () => ({ assigneeId: ['unassigned'], systemState: [...LIVE_STATES] }),
  },
  overdue: {
    key: 'overdue',
    query: () => ({ systemState: [...LIVE_STATES] }),
    predicate: isOverdue,
  },
  escalated: {
    key: 'escalated',
    query: () => ({ systemState: ['escalated'] }),
  },
};

export const viewByKey = (key: string | null | undefined): TicketView | null =>
  TICKET_VIEW_KEYS.includes(key as TicketViewKey) ? TICKET_VIEWS[key as TicketViewKey] : null;

/** The rows of a page this view actually shows, once its predicate has run. */
export const applyView = (
  view: TicketView | null,
  tickets: readonly Ticket[],
  now: number,
): readonly Ticket[] => {
  const predicate = view?.predicate;

  return predicate === undefined ? tickets : tickets.filter((ticket) => predicate(ticket, now));
};

export interface ViewCount {
  readonly count: number;
  /** True when the api has more pages, so the count is a floor and reads "n+". */
  readonly partial: boolean;
}

/**
 * What the sidebar prints beside a view.
 *
 * It is what one page of the list holds, not a `COUNT(*)`: the list is keyset
 * paged and the api offers no total, and a second endpoint whose only job is a
 * badge would be a second query per view on every screen. A brand with more
 * than a page of unassigned tickets sees "25+", which is the honest answer and
 * the one that means the same thing.
 */
export const viewCount = (view: TicketView, list: TicketList, now: number): ViewCount => ({
  count: applyView(view, list.tickets, now).length,
  partial: list.nextCursor !== null,
});
