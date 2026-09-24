import { z } from 'zod';

/**
 * Time tracking on a ticket (REQUIREMENTS §4.1, M1-12): manual entries from the
 * Log time dialog, the Time card's timer, and the per-reply timer the composer
 * sends with a message. Staff-only, like everything on the ticket that is not
 * the thread.
 */

/**
 * The longest single entry: the dialog's "hours 0–24, minutes 0–59"
 * (`AdminTicketDialogs`, panel 6). A timer left running overnight is capped by
 * the client rather than refused, so the ceiling is the same for both.
 */
export const MAX_TIME_ENTRY_SECONDS = 24 * 3600 + 59 * 60;

export const TIME_ENTRY_NOTE_MAX = 500;

/** Seconds, whole and above zero: "the total must be above zero". */
export const timeEntrySecondsSchema = z.int().min(1).max(MAX_TIME_ENTRY_SECONDS);

export const timeEntrySchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  userId: z.uuid(),
  /** Printed on the row ("Lina · with reply · Tue"). A deleted account reads "Former staff". */
  userName: z.string(),
  seconds: timeEntrySecondsSchema,
  note: z.string().nullable(),
  /** Set when the time was logged with a reply rather than on its own. */
  messageId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type TimeEntry = z.infer<typeof timeEntrySchema>;

/** Newest first, with the sum the card's header prints. */
export const timeEntryListSchema = z.object({
  entries: z.array(timeEntrySchema),
  totalSeconds: z.int().nonnegative(),
});
export type TimeEntryList = z.infer<typeof timeEntryListSchema>;

export const timeEntryCreateRequestSchema = z.object({
  seconds: timeEntrySecondsSchema,
  note: z
    .string()
    .trim()
    .max(TIME_ENTRY_NOTE_MAX)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});
export type TimeEntryCreateRequest = z.infer<typeof timeEntryCreateRequestSchema>;

export const timeEntryParamSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  entryId: z.uuid(),
});
export type TimeEntryParam = z.infer<typeof timeEntryParamSchema>;
