import {
  NOTIFICATION_KINDS,
  type NotificationDetail,
  type NotificationKind,
} from '@helpdock/schemas';
import { isUrgent } from './email-pacing.js';

/**
 * What a batch or digest says, before any language is chosen (M14-10,
 * artboard `Email/NotificationBatch`): a count per kind for the heading, the
 * rows that need the person now, and the rest folded so the email stays
 * short.
 *
 * - **Needs you now** lists mentions, breaches and escalations, one line per
 *   ticket.
 * - **Tickets** folds the rest per ticket ("Mona replied twice"), and per
 *   bulk operation ("Omar assigned you 3 tickets") once M14-03 records one on
 *   the row. A digest folds further, per kind across tickets ("7 tickets
 *   assigned to you"), because a day's worth listed per ticket is a report.
 *
 * References and who did what; never a message body.
 */

export interface BatchItem {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly ticketId: string;
  readonly reference: string;
  readonly subject: string;
  readonly contactName: string | null;
  readonly actorName: string | null;
  readonly detail: NotificationDetail;
  readonly createdAt: Date;
  /**
   * The bulk change that caused it. Always null until M14-03 adds
   * `notifications.bulk_operation_id`; the folding below is ready for it.
   */
  readonly bulkOperationId: string | null;
}

/** Who did it: a person by name, or one of the automatic assigners. */
export type ActorLabel =
  | { readonly name: string }
  | { readonly automatic: 'rule' | 'round_robin' | 'skill_based' };

export interface TicketEvent {
  readonly kind: NotificationKind;
  readonly count: number;
  readonly actors: readonly ActorLabel[];
  /** The latest row's detail: its clock, its step, how it was assigned. */
  readonly detail: NotificationDetail;
}

export type BatchLine =
  | {
      readonly type: 'ticket';
      readonly ticketId: string;
      readonly reference: string;
      readonly subject: string;
      readonly contactName: string | null;
      readonly events: readonly TicketEvent[];
    }
  | {
      readonly type: 'bulk';
      readonly kind: NotificationKind;
      readonly actors: readonly ActorLabel[];
      readonly references: readonly string[];
    }
  | {
      readonly type: 'rollup';
      readonly kind: NotificationKind;
      readonly ticketCount: number;
      readonly actors: readonly ActorLabel[];
      readonly references: readonly string[];
    };

export interface BatchContent {
  readonly total: number;
  /** The oldest row's time: "since 14:52". */
  readonly since: Date;
  /** Count per kind, in the preference table's order, kinds with none left out. */
  readonly counts: readonly (readonly [NotificationKind, number])[];
  readonly needsYouNow: readonly BatchLine[];
  readonly tickets: readonly BatchLine[];
}

/** A digest rolls a kind up once it touches this many tickets. */
const ROLLUP_MIN_TICKETS = 2;

const actorOf = (item: BatchItem): ActorLabel | null => {
  const by = item.kind === 'assigned' ? item.detail.assignedBy : undefined;
  if (by !== undefined && by !== 'person') {
    return { automatic: by };
  }

  return item.actorName === null ? null : { name: item.actorName };
};

const sameActor = (a: ActorLabel, b: ActorLabel): boolean =>
  'name' in a ? 'name' in b && a.name === b.name : 'automatic' in b && a.automatic === b.automatic;

const actorsOf = (items: readonly BatchItem[]): readonly ActorLabel[] => {
  const actors: ActorLabel[] = [];
  for (const item of items) {
    const actor = actorOf(item);
    if (actor !== null && !actors.some((known) => sameActor(known, actor))) {
      actors.push(actor);
    }
  }

  return actors;
};

const newestFirst = (a: BatchItem, b: BatchItem): number =>
  b.createdAt.getTime() - a.createdAt.getTime();

/** Groups keep the order their first member had in `items`. */
const groupBy = <K>(items: readonly BatchItem[], key: (item: BatchItem) => K): BatchItem[][] => {
  const groups = new Map<K, BatchItem[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) {
      groups.set(key(item), [item]);
    } else {
      group.push(item);
    }
  }

  return [...groups.values()];
};

const distinctReferences = (items: readonly BatchItem[]): string[] => [
  ...new Set(items.map((item) => item.reference)),
];

const ticketLines = (items: readonly BatchItem[]): BatchLine[] =>
  groupBy(items, (item) => item.ticketId).map((rows) => {
    const [first] = rows as [BatchItem, ...BatchItem[]];
    return {
      type: 'ticket',
      ticketId: first.ticketId,
      reference: first.reference,
      subject: first.subject,
      contactName: first.contactName,
      events: groupBy(rows, (row) => row.kind).map((same) => ({
        kind: (same[0] as BatchItem).kind,
        count: same.length,
        actors: actorsOf(same),
        detail: (same[0] as BatchItem).detail,
      })),
    };
  });

/** Rows of one bulk operation and kind that touch several tickets, as one line each. */
const bulkLines = (items: readonly BatchItem[]): { lines: BatchLine[]; rest: BatchItem[] } => {
  const lines: BatchLine[] = [];
  const folded = new Set<string>();
  const inBulk = items.filter((item) => item.bulkOperationId !== null && item.kind === 'assigned');

  for (const rows of groupBy(inBulk, (item) => item.bulkOperationId)) {
    const references = distinctReferences(rows);
    if (references.length < ROLLUP_MIN_TICKETS) {
      continue;
    }
    lines.push({ type: 'bulk', kind: 'assigned', actors: actorsOf(rows), references });
    for (const row of rows) {
      folded.add(row.id);
    }
  }

  return { lines, rest: items.filter((item) => !folded.has(item.id)) };
};

/** A digest's per-kind roll-ups, for kinds that touch several tickets. */
const rollupLines = (items: readonly BatchItem[]): { lines: BatchLine[]; rest: BatchItem[] } => {
  const lines: BatchLine[] = [];
  const rest: BatchItem[] = [];

  for (const rows of groupBy(items, (item) => item.kind)) {
    const references = distinctReferences(rows);
    if (references.length < ROLLUP_MIN_TICKETS) {
      rest.push(...rows);
      continue;
    }
    lines.push({
      type: 'rollup',
      kind: (rows[0] as BatchItem).kind,
      ticketCount: references.length,
      actors: actorsOf(rows),
      references,
    });
  }

  return { lines, rest };
};

export const groupBatch = (
  items: readonly BatchItem[],
  mode: 'batch' | 'digest',
): BatchContent | null => {
  if (items.length === 0) {
    return null;
  }

  const sorted = [...items].sort(newestFirst);
  const urgent = sorted.filter((item) => isUrgent(item.kind));
  const updates = sorted.filter((item) => !isUrgent(item.kind));
  const folded = mode === 'digest' ? rollupLines(updates) : bulkLines(updates);

  const counts = NOTIFICATION_KINDS.flatMap((kind) => {
    const count = items.filter((item) => item.kind === kind).length;
    return count === 0 ? [] : [[kind, count] as const];
  });
  const since = new Date(Math.min(...items.map((item) => item.createdAt.getTime())));

  return {
    total: items.length,
    since,
    counts,
    needsYouNow: ticketLines(urgent),
    tickets: [...folded.lines, ...ticketLines(folded.rest)],
  };
};
