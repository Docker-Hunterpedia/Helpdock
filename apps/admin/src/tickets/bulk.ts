import type { BULK_ME, BulkChanges, BulkResponse, TicketPriority } from '@helpdock/schemas';
import { isAuthError } from '../auth/api.js';
import { isTicketLifecycleError } from './api.js';

/**
 * What the bulk bar asks for and how the answer is read (M14-04). Pure, so the
 * wording rules and the error mapping are proven without a screen.
 */

/** One thing the bar can do to the selected tickets. */
export type BulkChoice =
  | { readonly kind: 'status'; readonly statusId: string }
  | { readonly kind: 'close' }
  | { readonly kind: 'priority'; readonly priority: TicketPriority }
  | { readonly kind: 'assignee'; readonly assigneeId: string | typeof BULK_ME | null }
  | { readonly kind: 'team'; readonly teamId: string | null }
  | { readonly kind: 'department'; readonly departmentId: string }
  | {
      readonly kind: 'tags';
      readonly addTagIds: readonly string[];
      readonly removeTagIds: readonly string[];
    }
  | { readonly kind: 'snooze'; readonly until: string | null }
  | { readonly kind: 'spam' }
  | { readonly kind: 'field'; readonly key: string; readonly value: unknown };

export type BulkKind = BulkChoice['kind'];

export function changesOf(choice: BulkChoice): BulkChanges {
  switch (choice.kind) {
    case 'status':
      return { statusId: choice.statusId };
    case 'close':
      return { close: true };
    case 'priority':
      return { priority: choice.priority };
    case 'assignee':
      return { assigneeId: choice.assigneeId };
    case 'team':
      return { teamId: choice.teamId };
    case 'department':
      return { departmentId: choice.departmentId };
    case 'tags':
      return {
        ...(choice.addTagIds.length === 0 ? {} : { addTagIds: [...choice.addTagIds] }),
        ...(choice.removeTagIds.length === 0 ? {} : { removeTagIds: [...choice.removeTagIds] }),
      };
    case 'snooze':
      return { snoozedUntil: choice.until };
    case 'spam':
      return { spam: true };
    case 'field':
      return { customField: { key: choice.key, value: choice.value } };
  }
}

// ------------------------------------------------------------------ reading a preview

export type BlockReason =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'notFound' };

export interface Blocker {
  readonly ticketId: string;
  readonly reason: BlockReason;
}

export interface PreviewSummary {
  readonly total: number;
  /** The ids that would change, in the order the tickets were named: what `apply` expects. */
  readonly changing: readonly string[];
  /** Every ticket that would not, with why. */
  readonly blockers: readonly Blocker[];
}

export function summarise(response: BulkResponse): PreviewSummary {
  const changing: string[] = [];
  const blockers: Blocker[] = [];
  for (const result of response.results) {
    if (result.outcome === 'will_change') {
      changing.push(result.ticketId);
    } else if (result.outcome === 'unchanged') {
      blockers.push({ ticketId: result.ticketId, reason: { kind: 'unchanged' } });
    } else if (result.outcome === 'refused') {
      blockers.push({
        ticketId: result.ticketId,
        reason: { kind: 'refused', code: result.code ?? 'other' },
      });
    } else {
      blockers.push({ ticketId: result.ticketId, reason: { kind: 'notFound' } });
    }
  }

  return { total: response.results.length, changing, blockers };
}

/** Refusal codes the catalogs have a sentence for; any other code reads as {@link OTHER_REASON}. */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  'ticket-closed',
  'ticket-merged',
  'ticket-deleted',
  'snooze-requires-time',
  'assignee-above-actor',
  'not-eligible',
  'fields-required-to-close',
  'unknown-reference',
  'invalid',
  'forbidden',
  'conflict',
]);

/** The `tickets` catalog key of the sentence that says why a ticket will not change. */
export function reasonKey(reason: BlockReason, choice: BulkChoice): string {
  switch (reason.kind) {
    case 'unchanged':
      return choice.kind === 'close' ? 'bulk.reason.unchangedClose' : 'bulk.reason.unchanged';
    case 'notFound':
      return 'bulk.reason.notFound';
    case 'refused':
      return KNOWN_CODES.has(reason.code) ? `bulk.reason.${reason.code}` : 'bulk.reason.other';
  }
}

/** Which title, button and toast wording a choice uses. Closing has its own; the rest share one. */
export const dialogKindOf = (choice: BulkChoice): 'close' | 'change' =>
  choice.kind === 'close' ? 'close' : 'change';

export type ToastKind = 'close' | 'spam' | 'snooze' | 'assign' | 'changed';

export function toastKindOf(choice: BulkChoice): ToastKind {
  switch (choice.kind) {
    case 'close':
      return 'close';
    case 'spam':
      return 'spam';
    case 'snooze':
      return choice.until === null ? 'changed' : 'snooze';
    case 'assignee':
      return 'assign';
    default:
      return 'changed';
  }
}

// ------------------------------------------------------------------ failures

export type BulkFailure =
  /** 409 `bulk-changed`: something previewed was edited meanwhile; preview again. */
  | { readonly kind: 'changed' }
  /** 429: the person's budget of applies and undos is spent. */
  | { readonly kind: 'rateLimited'; readonly retryAfter: number | undefined }
  | { readonly kind: 'expired' }
  | { readonly kind: 'alreadyUndone' }
  /** The api answered with a refusal: it did not do what was asked. */
  | { readonly kind: 'failed' }
  /**
   * No answer the api stands behind (a lost connection, a 5xx, a body that is
   * not its own): an apply may have committed, so nothing can be claimed.
   */
  | { readonly kind: 'unknown' };

export function failureOf(error: unknown): BulkFailure {
  if (isTicketLifecycleError(error)) {
    switch (error.reason) {
      case 'bulk-changed':
        return { kind: 'changed' };
      case 'bulk-undo-expired':
        return { kind: 'expired' };
      case 'bulk-already-undone':
        return { kind: 'alreadyUndone' };
    }
  }
  if (isAuthError(error) && error.code === 'rate-limited') {
    return { kind: 'rateLimited', retryAfter: error.retryAfter };
  }

  // An answer with a 4xx status, or one of the api's coded refusals, is the api saying no.
  if (isAuthError(error) && (error.code !== 'unavailable' || isClientError(error.status))) {
    return { kind: 'failed' };
  }
  if (isTicketLifecycleError(error)) {
    return { kind: 'failed' };
  }

  return { kind: 'unknown' };
}

const isClientError = (status: number | undefined): boolean =>
  status !== undefined && status >= 400 && status < 500;
