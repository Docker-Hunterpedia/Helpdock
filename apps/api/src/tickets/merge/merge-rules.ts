import type {
  Attachment as AttachmentRow,
  TicketMessage as TicketMessageRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { type TicketLifecycleRefusal, UNMERGE_WINDOW_MS } from '@helpdock/schemas';
import { type TicketLifecycleFacts, transitionFor } from '../lifecycle/transitions.js';

/**
 * [DOMAIN-RULES §2.4](../../../../../docs/planning/DOMAIN-RULES.md#24-merge-and-split)
 * as pure functions of rows the caller has already read.
 *
 * They are apart from `merge.service.ts` for the reason `lifecycle/status-rules.ts`
 * gives: the rules are the part a reviewer reads beside the document, and a
 * rule that needs a database to be tested is a rule that gets tested once.
 * Nothing here reads the clock; `now` is passed in.
 */

/** What a merge needs to know about one side. */
export interface MergeSide extends TicketLifecycleFacts {
  readonly id: string;
}

/**
 * Why this merge is refused, or `null` when it may go ahead.
 *
 * The secondary answers through §2.2's table, which already refuses a merged
 * or deleted ticket — so a secondary is merged once, and unmerge is the only
 * way back. The primary is refused when it is itself merged: its state belongs
 * to the ticket it went into, and merging into it would build a chain nobody
 * chose. Refusing that one case is also what makes a cycle impossible.
 */
export const mergeRefusal = (
  secondary: MergeSide,
  primary: MergeSide,
): TicketLifecycleRefusal | null => {
  if (secondary.id === primary.id) {
    return 'merge-into-self';
  }

  const outcome = transitionFor(secondary, 'merge');
  if (outcome.kind === 'refused') {
    return outcome.reason;
  }

  if (primary.mergedIntoId !== null) {
    return 'merge-into-merged';
  }

  return null;
};

/** The end of the 24 hours a merge made at `mergedAt` can be undone in. */
const unmergeDeadline = (mergedAt: Date): Date => new Date(mergedAt.getTime() + UNMERGE_WINDOW_MS);

/**
 * Until when this merge can still be undone, or `null` once it cannot. The
 * screen offers Unmerge exactly while this is not null.
 */
export const unmergeableUntil = (mergedAt: Date | null, now: Date): Date | null => {
  if (mergedAt === null) {
    return null;
  }

  const deadline = unmergeDeadline(mergedAt);

  return deadline.getTime() > now.getTime() ? deadline : null;
};

/** What an unmerge needs to know about the secondary. */
export interface UnmergeFacts {
  readonly mergedIntoId: string | null;
  readonly mergedAt: Date | null;
}

/**
 * Why this unmerge is refused, or `null`. The window is measured from
 * `merged_at` and closes at exactly 24 hours: a request arriving on the stroke
 * of it is refused, the same instant the screen stops offering the button.
 */
export const unmergeRefusal = (
  ticket: UnmergeFacts,
  now: Date,
): 'ticket-not-merged' | 'merge-window-closed' | null => {
  if (ticket.mergedIntoId === null || ticket.mergedAt === null) {
    return 'ticket-not-merged';
  }

  return unmergeableUntil(ticket.mergedAt, now) === null ? 'merge-window-closed' : null;
};

/**
 * `closed_at` once a merge closes the secondary: the moment of the merge, or
 * the one it already had if it was closed before — it has not been closed
 * twice, the rule `status-change.ts` already follows for Closed to Spam.
 */
export const closedAtOnMerge = (closedAt: Date | null, now: Date): Date => closedAt ?? now;

/**
 * `closed_at` once an unmerge restores the status the secondary was in. Kept
 * when that status is itself a closed one; cleared otherwise, because an open
 * ticket with a `closed_at` would be a ticket every report reads as resolved.
 */
export const closedAtOnUnmerge = (
  restored: Pick<TicketStatusRow, 'systemState'>,
  closedAt: Date | null,
): Date | null => (restored.systemState === 'closed' ? closedAt : null);

/** How long a merge lasted, which the clocks leave out when they resume (§2.4). */
export const mergedDuration = (mergedAt: Date, now: Date): number =>
  Math.max(0, now.getTime() - mergedAt.getTime());

/** Why a split's selection is refused. */
export type SplitProblem =
  /** An id that is not a message of this ticket, or not one this caller may read. */
  | 'not_found'
  /** A system message: "Continued in HD-1101" means nothing on another ticket. */
  | 'system_message'
  /** An attachment the pipeline has not finished with; its copy would never finish. */
  | 'attachments-in-flight';

export type SplitSelection =
  | { readonly ok: true; readonly messages: readonly TicketMessageRow[] }
  | { readonly ok: false; readonly problem: SplitProblem };

/**
 * The messages a split copies, oldest first, or why it cannot.
 *
 * `found` is what the ticket holds of the requested ids, read through the
 * request's transaction. A requested id missing from it is refused rather than
 * skipped: a split that quietly dropped a message is a split somebody believes
 * carried it.
 */
export const splitSelection = (
  requestedIds: readonly string[],
  found: readonly TicketMessageRow[],
  attachments: ReadonlyMap<string, readonly AttachmentRow[]>,
): SplitSelection => {
  const byId = new Map(found.map((message) => [message.id, message]));
  const wanted = [...new Set(requestedIds)];

  if (wanted.some((id) => !byId.has(id))) {
    return { ok: false, problem: 'not_found' };
  }

  const messages = wanted
    .map((id) => byId.get(id))
    .filter((message): message is TicketMessageRow => message !== undefined)
    .sort((left, right) => left.seq - right.seq);

  if (messages.some((message) => message.kind === 'system')) {
    return { ok: false, problem: 'system_message' };
  }

  const inFlight = messages.some((message) =>
    (attachments.get(message.id) ?? []).some(
      (attachment) => attachment.status === 'pending' || attachment.status === 'processing',
    ),
  );
  if (inFlight) {
    return { ok: false, problem: 'attachments-in-flight' };
  }

  return { ok: true, messages };
};

/**
 * The attachments a copied message carries: the ones a reader could open.
 * Rejected and infected rows are left behind — their objects are gone or must
 * never be served, so a copy of them would be a chip that leads nowhere.
 */
export const copyableAttachments = (rows: readonly AttachmentRow[]): readonly AttachmentRow[] =>
  rows.filter((row) => row.status === 'ready');

/**
 * The contact a merge adds to the primary as a CC (§2.4: "if different, the
 * secondary's contact is added as a CC participant"), or `null` when there is
 * nobody to add: the secondary has no contact, or it is the same person.
 */
export const addedContact = (
  primary: { readonly contactId: string | null },
  secondary: { readonly contactId: string | null },
): string | null =>
  secondary.contactId !== null && secondary.contactId !== primary.contactId
    ? secondary.contactId
    : null;
