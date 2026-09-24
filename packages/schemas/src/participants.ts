import { z } from 'zod';
import { MAX_IDENTITY_LENGTH } from './contact.js';
import { ticketParamSchema } from './ticket.js';

/**
 * A ticket's participants (DOMAIN-RULES §2.5, M1-13): its contact, its CCs and
 * its staff. They decide who may thread into the ticket by email (§4.3) and who
 * receives public replies, which is M2's; this milestone keeps the list.
 */

export const ticketParticipantSourceSchema = z.enum(['agent', 'email', 'merge']);
export type TicketParticipantSource = z.infer<typeof ticketParticipantSourceSchema>;

/** One CC. `id` is the participant row, which is what a removal names. */
export const ticketCcSchema = z.object({
  id: z.uuid(),
  contactId: z.uuid(),
  name: z.string().min(1),
  /** The normalised address it was added under; null when a merge brought a contact with none. */
  address: z.string().max(MAX_IDENTITY_LENGTH).nullable(),
  source: ticketParticipantSourceSchema,
});
export type TicketCc = z.infer<typeof ticketCcSchema>;

export const ticketParticipantListSchema = z.object({
  /** The ticket's own contact, or null for a ticket that has none. */
  contact: z
    .object({
      id: z.uuid(),
      name: z.string().min(1),
    })
    .nullable(),
  ccs: z.array(ticketCcSchema),
  /** The assignee and every staff member who wrote on the ticket, once each. */
  staff: z.array(z.object({ userId: z.uuid(), name: z.string().min(1) })),
});
export type TicketParticipantList = z.infer<typeof ticketParticipantListSchema>;

export const ticketCcRequestSchema = z.object({
  email: z.string().trim().min(1).max(MAX_IDENTITY_LENGTH),
});
export type TicketCcRequest = z.infer<typeof ticketCcRequestSchema>;

export const ticketParticipantParamSchema = ticketParamSchema.extend({
  participantId: z.uuid(),
});
export type TicketParticipantParam = z.infer<typeof ticketParticipantParamSchema>;
