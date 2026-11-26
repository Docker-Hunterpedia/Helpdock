import { z } from 'zod';
import { CUSTOMER_STATUSES } from './ticket-status.js';

/**
 * What a customer is told about a ticket (M21-03), as Zod output schemas.
 *
 * A row policy cannot hide a column, so the guarantee that a note, a priority
 * or an object key never reaches a portal page is made here: each shape lists
 * the fields it has and `strictObject` refuses any other, so a field added to a
 * table is not a field of a page until somebody writes it down below. The
 * builders in `db-ticket-reader.ts` pass everything through `.parse`, and the
 * pages read these types and nothing else. Every deny-listed column of the
 * milestone doc is absent by construction, and `ticket-views.test.ts` checks it
 * on the serialised output of a row with all of them set.
 */

const isoInstant = z.iso.datetime();
const status = z.enum(CUSTOMER_STATUSES);

/** Who opened a ticket, as the viewer reads it. `person` is a coworker or somebody else of the requester's. */
const openedBy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('you') }),
  z.strictObject({ kind: z.literal('person'), name: z.string().max(200) }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type PortalOpenedBy = z.infer<typeof openedBy>;

export const portalTicketRowSchema = z.strictObject({
  reference: z.string().max(40),
  subject: z.string().max(1000),
  status,
  updatedAt: isoInstant,
  /** Only on the company's list; null on Mine. */
  openedBy: openedBy.nullable(),
  /** The customer's own ticket that staff or they marked private. */
  onlyYou: z.boolean(),
});
export type PortalTicketRow = z.infer<typeof portalTicketRowSchema>;

export const portalTicketListSchema = z.strictObject({
  rows: z.array(portalTicketRowSchema).max(100),
  /** Opaque; null on the last page. */
  nextCursor: z.string().max(200).nullable(),
  /** Open (or Solved, with that filter) tickets in each list, capped at 100 so a count is never a table scan. */
  counts: z.strictObject({
    mine: z.number().int().min(0),
    company: z.number().int().min(0).nullable(),
  }),
});
export type PortalTicketList = z.infer<typeof portalTicketListSchema>;

export const portalAttachmentSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().max(255),
  mime: z.string().max(255),
  size: z.number().int().min(0),
  kind: z.string().max(40),
});
export type PortalAttachment = z.infer<typeof portalAttachmentSchema>;

/**
 * Who wrote a message. `staff` is the public name of §2.10 and nothing more
 * (never the full name, the address or a photo); `brand` is the assistant and
 * the system, which carry the brand's name alone.
 */
const author = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('you') }),
  z.strictObject({ kind: z.literal('coworker'), name: z.string().max(200) }),
  z.strictObject({ kind: z.literal('other'), name: z.string().max(200).nullable() }),
  z.strictObject({ kind: z.literal('staff'), name: z.string().max(200) }),
  z.strictObject({ kind: z.literal('brand') }),
]);
export type PortalAuthor = z.infer<typeof author>;

export const portalMessageSchema = z.strictObject({
  id: z.uuid(),
  author,
  at: isoInstant,
  /** Plain text: the page escapes it and splits it into paragraphs; it is never parsed as markup. */
  text: z.string().max(200_000),
  /** The text was cut (`portal-clip.ts`); the page says so. */
  truncated: z.boolean(),
  attachments: z.array(portalAttachmentSchema).max(50),
  /** Files beyond the first 50 on this message, not listed. */
  moreFiles: z.number().int().min(0),
});
export type PortalMessage = z.infer<typeof portalMessageSchema>;

export const portalTicketSchema = z.strictObject({
  reference: z.string().max(40),
  subject: z.string().max(1000),
  status,
  openedBy,
  createdAt: isoInstant,
  channel: z.enum([
    'email',
    'chat',
    'telegram',
    'form',
    'api',
    'manual',
    'whatsapp',
    'messenger',
    'instagram',
  ]),
  /** Whether the viewer opened it themselves. A coworker's ticket is read in company mode. */
  mine: z.boolean(),
  messages: z.array(portalMessageSchema),
});
export type PortalTicket = z.infer<typeof portalTicketSchema>;

export type TicketLookup =
  | { readonly kind: 'found'; readonly ticket: PortalTicket }
  /** A merged-away ticket's reference, when the viewer can see what it was merged into. */
  | { readonly kind: 'moved'; readonly reference: string }
  | { readonly kind: 'missing' };

/** A short-lived address for one file, or nothing: the same answer for every reason. */
export type AttachmentLookup = { readonly url: string } | null;
