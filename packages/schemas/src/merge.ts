import { z } from 'zod';
import {
  TICKET_PAGE_SIZE_MAX,
  TICKET_SUBJECT_MAX,
  ticketPrioritySchema,
  ticketSchema,
} from './ticket.js';

/**
 * The requests of M1-09 — merge, unmerge and split (DOMAIN-RULES §2.4) — and
 * what they answer. The read side, the merged block a primary's thread draws,
 * is part of `ticketDetailSchema` in `ticket.ts`.
 */

/**
 * `POST /tickets/:ticketId/merge`: the ticket in the path is the **secondary**,
 * which closes into the one named here. The path names the ticket the agent is
 * looking at, which is the one the ⋯ menu was opened on.
 */
export const ticketMergeRequestSchema = z.object({
  primaryTicketId: z.uuid(),
});
export type TicketMergeRequest = z.infer<typeof ticketMergeRequestSchema>;

/** Both halves of a merge or an unmerge, as they are afterwards. */
export const ticketMergeResultSchema = z.object({
  primary: ticketSchema,
  secondary: ticketSchema,
});
export type TicketMergeResult = z.infer<typeof ticketMergeResultSchema>;

/**
 * `POST /tickets/:ticketId/split`: the messages to copy onto a new ticket, and
 * the three things the agent chooses for it. The contact is the original's
 * (§2.4: "same contact"), so it is not asked for.
 */
export const ticketSplitRequestSchema = z.object({
  messageIds: z.array(z.uuid()).min(1).max(TICKET_PAGE_SIZE_MAX),
  subject: z.string().trim().min(1).max(TICKET_SUBJECT_MAX),
  departmentId: z.uuid(),
  /** Absent means the original's priority. */
  priority: ticketPrioritySchema.optional(),
});
export type TicketSplitRequest = z.infer<typeof ticketSplitRequestSchema>;
