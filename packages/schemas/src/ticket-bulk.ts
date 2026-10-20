import { z } from 'zod';
import { MAX_TAGS_PER_BRAND } from './tags.js';
import { ticketPrioritySchema } from './ticket.js';

/**
 * M14-03: the bulk edit (DOMAIN-RULES §2.7, ADR 0036).
 *
 * One request carries up to fifty ticket ids and one set of changes, and is
 * answered per ticket. `preview` writes nothing; `apply` is one transaction,
 * all or nothing against the ids the preview said would change. Staff only:
 * the public API v1 has no bulk route, a client loops with idempotency keys.
 */

/** Tickets one bulk request may name. */
export const BULK_MAX_TICKETS = 50;
/** How long after an apply its person may undo it. */
export const BULK_UNDO_WINDOW_SECONDS = 60;
/** Applies and undos one person may make in a minute. */
export const BULK_OPERATIONS_PER_MINUTE = 20;
/** Previews one person may ask for in a minute; they write nothing but do the same checks. */
export const BULK_PREVIEWS_PER_MINUTE = 60;

/** The assignee `me` means the person making the request. */
export const BULK_ME = 'me';

const tagIdsSchema = z.array(z.uuid()).min(1).max(MAX_TAGS_PER_BRAND);

/**
 * What a bulk edit may change. Strict, so a field this schema does not name
 * (a reply, a note, a merge, a delete) is refused rather than ignored.
 *
 * The status-like changes (`statusId`, `close`, `snoozedUntil`, `spam`) are one
 * at a time: each is a transition with its own rules, and two at once would
 * have no order the person could have previewed.
 */
export const bulkChangesSchema = z
  .strictObject({
    /** Any status except Snoozed, which is entered with a wake time through `snoozedUntil`. */
    statusId: z.uuid().optional(),
    /** Moves to the brand's Closed status. */
    close: z.literal(true).optional(),
    priority: ticketPrioritySchema.optional(),
    /** A person, `me`, or `null` for nobody. */
    assigneeId: z.union([z.uuid(), z.literal(BULK_ME), z.null()]).optional(),
    teamId: z.uuid().nullable().optional(),
    departmentId: z.uuid().optional(),
    addTagIds: tagIdsSchema.optional(),
    removeTagIds: tagIdsSchema.optional(),
    /** An instant to snooze until, or `null` to wake. */
    snoozedUntil: z.iso.datetime().nullable().optional(),
    /** Marks spam. Never blocks the sender: that stays a single-ticket choice. */
    spam: z.literal(true).optional(),
    /** One custom field value, by the field's key; `null` clears it. */
    customField: z.strictObject({ key: z.string().min(1).max(64), value: z.unknown() }).optional(),
  })
  .superRefine((changes, ctx) => {
    const named = Object.values(changes).filter((value) => value !== undefined);
    if (named.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'A bulk edit changes something' });
    }

    const transitions = [
      changes.statusId !== undefined,
      changes.close !== undefined,
      changes.snoozedUntil !== undefined,
      changes.spam !== undefined,
    ].filter(Boolean).length;
    if (transitions > 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Change the status, close, snooze or mark spam one at a time',
      });
    }

    const removing = new Set(changes.removeTagIds ?? []);
    if ((changes.addTagIds ?? []).some((id) => removing.has(id))) {
      ctx.addIssue({ code: 'custom', message: 'A tag cannot be added and removed at once' });
    }
  });
export type BulkChanges = z.infer<typeof bulkChangesSchema>;

export const bulkModeSchema = z.enum(['preview', 'apply']);
export type BulkMode = z.infer<typeof bulkModeSchema>;

export const bulkRequestSchema = z
  .strictObject({
    ticketIds: z.array(z.uuid()).min(1).max(BULK_MAX_TICKETS),
    changes: bulkChangesSchema,
    mode: bulkModeSchema,
    /** The ids the preview said would change. Required to apply. */
    expect: z.array(z.uuid()).max(BULK_MAX_TICKETS).optional(),
  })
  .superRefine((request, ctx) => {
    if (new Set(request.ticketIds).size !== request.ticketIds.length) {
      ctx.addIssue({ code: 'custom', path: ['ticketIds'], message: 'Ticket ids must be unique' });
    }

    if (request.mode === 'apply' && request.expect === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect'],
        message: 'Apply names the tickets the preview said would change',
      });
    }

    if (request.mode === 'preview' && request.expect !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['expect'], message: 'Preview takes no expect' });
    }

    const named = new Set(request.ticketIds);
    if ((request.expect ?? []).some((id) => !named.has(id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect'],
        message: 'Expect names a ticket that is not in ticketIds',
      });
    }
  });
export type BulkRequest = z.infer<typeof bulkRequestSchema>;

export const bulkOutcomeSchema = z.enum(['will_change', 'unchanged', 'refused', 'not_found']);
export type BulkOutcome = z.infer<typeof bulkOutcomeSchema>;

/** The fields of a ticket a bulk edit moves, by the names the changes use. */
export const bulkFieldSchema = z.enum([
  'statusId',
  'priority',
  'assigneeId',
  'teamId',
  'departmentId',
  'snoozedUntil',
  'spam',
  'tags',
  'custom',
]);
export type BulkField = z.infer<typeof bulkFieldSchema>;

export const bulkTicketResultSchema = z.object({
  ticketId: z.uuid(),
  outcome: bulkOutcomeSchema,
  /** The fields that move, for `will_change`. */
  fields: z.array(bulkFieldSchema),
  /** The refusal code, for `refused`: the same code the single-ticket path answers with. */
  code: z.string().nullable(),
});
export type BulkTicketResult = z.infer<typeof bulkTicketResultSchema>;

export const bulkCountsSchema = z.object({
  willChange: z.int().nonnegative(),
  unchanged: z.int().nonnegative(),
  refused: z.int().nonnegative(),
  notFound: z.int().nonnegative(),
});
export type BulkCounts = z.infer<typeof bulkCountsSchema>;

export const bulkResponseSchema = z.object({
  mode: bulkModeSchema,
  /** In the order the tickets were named. */
  results: z.array(bulkTicketResultSchema),
  counts: bulkCountsSchema,
  /** Set by an apply that changed something; the handle Undo takes. */
  operationId: z.uuid().nullable(),
  undoUntil: z.iso.datetime().nullable(),
});
export type BulkResponse = z.infer<typeof bulkResponseSchema>;

export const bulkOperationParamSchema = z.object({
  brandId: z.uuid(),
  operationId: z.uuid(),
});
export type BulkOperationParam = z.infer<typeof bulkOperationParamSchema>;

export const bulkUndoOutcomeSchema = z.enum(['reverted', 'partly_reverted', 'kept', 'not_found']);
export type BulkUndoOutcome = z.infer<typeof bulkUndoOutcomeSchema>;

export const bulkUndoTicketResultSchema = z.object({
  ticketId: z.uuid(),
  outcome: bulkUndoOutcomeSchema,
  reverted: z.array(bulkFieldSchema),
  /** Fields somebody changed since, or a rule refused to put back; left as they are. */
  kept: z.array(bulkFieldSchema),
  /** Why a rule refused to put a field back, when one did. */
  code: z.string().nullable(),
});
export type BulkUndoTicketResult = z.infer<typeof bulkUndoTicketResultSchema>;

export const bulkUndoResponseSchema = z.object({
  operationId: z.uuid(),
  results: z.array(bulkUndoTicketResultSchema),
  /** Tickets of the operation the person can no longer see (moved to a department they cannot read). */
  notFound: z.int().nonnegative(),
});
export type BulkUndoResponse = z.infer<typeof bulkUndoResponseSchema>;
