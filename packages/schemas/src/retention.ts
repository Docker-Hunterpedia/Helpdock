import { z } from 'zod';

/**
 * Per-brand data retention (DOMAIN-RULES §11, M1-14): what the Data retention
 * form edits, what the nightly `maintenance.retention` job obeys, and what the
 * form shows about the next and the last run.
 *
 * Every window is a whole number of days, and every field carries §11's
 * default so a brand that never opened the form still has an answer.
 */

/** The longest window the form accepts: ten years, well past any legal hold a brand asks for. */
export const RETENTION_MAX_DAYS = 3_650;
/** §11: "Audit log — 2 years, minimum 90 days". */
export const AUDIT_LOG_MIN_DAYS = 90;
/** §11: "Outbox, job receipts — 7 days after publish/complete". Fixed, not a brand setting. */
export const OUTBOX_RETENTION_DAYS = 7;

const days = (min = 1) => z.int().min(min).max(RETENTION_MAX_DAYS);

/**
 * Closed tickets are kept **forever** by default: deleting a support history is
 * a decision a brand makes, never one it inherits. A union rather than a
 * nullable number, so "never" cannot be written as a day count nobody reads —
 * the same shape as the reopen policy.
 */
export const closedTicketRetentionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('days'), days: days() }),
]);
export type ClosedTicketRetention = z.infer<typeof closedTicketRetentionSchema>;

export const retentionSettingsSchema = z.object({
  closedTickets: closedTicketRetentionSchema.default({ kind: 'never' }),
  spamTicketDays: days().default(30),
  /**
   * Bodies are nulled and counts kept. Stored now so the form is whole; the
   * purge that acts on it arrives with `ai_calls` (M7).
   */
  aiCallDays: days().default(90),
  /** Stored now; acted on once the help center search log exists (M5). */
  searchLogDays: days().default(180),
  auditLogDays: days(AUDIT_LOG_MIN_DAYS).default(730),
  /** Stored now; acted on once visitor sessions exist (M4). */
  visitorSessionDays: days().default(30),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

/** What a brand is kept under until an Admin saves the form. */
export const defaultRetentionSettings = (): RetentionSettings => retentionSettingsSchema.parse({});

/**
 * `PUT /api/brands/:brandId/retention` sends the whole form, as the screen
 * always holds the complete value. Every field is required here: a half-sent
 * body would silently reset what it left out, and for a retention window a
 * silent reset is a purge nobody chose.
 */
export const retentionUpdateRequestSchema = z.object({
  closedTickets: closedTicketRetentionSchema,
  spamTicketDays: days(),
  aiCallDays: days(),
  searchLogDays: days(),
  auditLogDays: days(AUDIT_LOG_MIN_DAYS),
  visitorSessionDays: days(),
});
export type RetentionUpdateRequest = z.infer<typeof retentionUpdateRequestSchema>;

/**
 * The categories the job purges and the form lists, in the form's order. The
 * outbox is last and not on the form: its window is fixed by §6.
 */
export const retentionCategorySchema = z.enum([
  'closedTickets',
  'spamTickets',
  'aiCalls',
  'searchLog',
  'auditLog',
  'visitorSessions',
  'outbox',
]);
export type RetentionCategory = z.infer<typeof retentionCategorySchema>;

/**
 * "Next purge" per row: how many rows would go if the job ran now under the
 * saved windows. `null` when there is nothing to count — "never" for closed
 * tickets, or a table that does not exist yet — which the form draws as "—".
 */
export const retentionPreviewSchema = z.object({
  closedTickets: z.int().nonnegative().nullable(),
  spamTickets: z.int().nonnegative().nullable(),
  aiCalls: z.int().nonnegative().nullable(),
  searchLog: z.int().nonnegative().nullable(),
  auditLog: z.int().nonnegative().nullable(),
  visitorSessions: z.int().nonnegative().nullable(),
});
export type RetentionPreview = z.infer<typeof retentionPreviewSchema>;

/** Counts by category. Never an id and never a value: this is what the audit row carries too. */
export const retentionCountsSchema = z.partialRecord(
  retentionCategorySchema,
  z.int().nonnegative(),
);
export type RetentionCounts = z.infer<typeof retentionCountsSchema>;

export const retentionLastRunSchema = z.object({
  at: z.iso.datetime(),
  counts: retentionCountsSchema,
  total: z.int().nonnegative(),
});
export type RetentionLastRun = z.infer<typeof retentionLastRunSchema>;

/** What the Data retention form reads, and what a save answers with. */
export const retentionOverviewSchema = z.object({
  settings: retentionSettingsSchema,
  preview: retentionPreviewSchema,
  lastRun: retentionLastRunSchema.nullable(),
});
export type RetentionOverview = z.infer<typeof retentionOverviewSchema>;

/** The sum of a run's counts, which is the number the form's footer prints. */
export const retentionTotal = (counts: RetentionCounts): number =>
  Object.values(counts).reduce<number>((sum, value) => sum + (value ?? 0), 0);
