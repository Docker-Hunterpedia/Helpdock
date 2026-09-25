import type {
  Attachment as AttachmentRow,
  TicketActivityEntry as TicketActivityRow,
  TicketMessage as TicketMessageRow,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import type {
  Tag,
  Ticket,
  TicketActivityEntry,
  TicketContact,
  TicketMessage,
  TicketStatus,
} from '@helpdock/schemas';
import { toAttachment } from '../media/attachment-view.js';

/**
 * Rows to the wire shapes of `@helpdock/schemas`. The output DTO parses these
 * again on the way out (ARCHITECTURE §6, step 5), so this is not the security
 * boundary — it is where the two vocabularies meet, in one file, so that a
 * column added to a table does not quietly become a field in a response.
 *
 * Three columns are deliberately never mapped:
 *
 * | Column | Why |
 * |---|---|
 * | `tickets.brand_id` | The caller named the brand in the path; echoing it says nothing |
 * | `tickets.search` | A tsvector is an index, not content |
 * | `ticket_messages.department_id` | Denormalised for the policy; the ticket already carries the department |
 *
 * `ticket_messages.external_message_id` and `ai_meta` are also absent: the
 * first is a channel's internal handle for threading and the second is cost
 * accounting. Neither belongs in a thread a person reads, and M8's public API
 * will decide separately what it exposes.
 */

/**
 * The contact a ticket names, from a page's `id → name` lookup. `null` when it
 * names none, or one the lookup did not return — which row-level security
 * makes "not in this brand", and which a row should draw as nobody rather than
 * as a guess.
 */
export const ticketContactOf = (
  contactId: string | null,
  names: ReadonlyMap<string, string>,
): TicketContact | null => {
  const name = contactId === null ? undefined : names.get(contactId);

  return contactId === null || name === undefined ? null : { id: contactId, name };
};

export const toTicketStatus = (row: TicketStatusRow): TicketStatus => ({
  id: row.id,
  name: row.name,
  nameAr: row.nameAr,
  systemState: row.systemState,
  pausesSla: row.pausesSla,
  awaitingCustomer: row.awaitingCustomer,
  isDefault: row.isDefault,
  isSystem: row.isSystem,
  excludedFromReports: row.excludedFromReports,
  isSpam: row.isSpam,
  sortOrder: row.sortOrder,
  color: row.color,
});

/**
 * M1-06: the chips are passed in rather than read here, because a list of fifty
 * rows reads them once for the whole page (`ticketing/ticket-tags.ts`). A
 * caller with none to hand passes nothing and the ticket carries an empty list,
 * which is what a ticket with no tags has.
 *
 * M1-15: `contact` likewise, and for the same reason. `undefined` leaves the
 * field off — the response did not resolve it, or the caller may not read
 * contacts — which is different from `null`, "this ticket names nobody".
 */
export const toTicket = (
  ticket: TicketRow,
  status: TicketStatusRow,
  tags: readonly Tag[] = [],
  contact?: TicketContact | null,
): Ticket => ({
  id: ticket.id,
  number: ticket.number,
  prefix: ticket.prefix,
  subject: ticket.subject,
  status: toTicketStatus(status),
  priority: ticket.priority,
  channel: ticket.channel,
  departmentId: ticket.departmentId,
  teamId: ticket.teamId,
  assigneeId: ticket.assigneeId,
  contactId: ticket.contactId,
  parentId: ticket.parentId,
  mergedIntoId: ticket.mergedIntoId,
  splitFromId: ticket.splitFromId,
  firstResponseDueAt: ticket.firstResponseDueAt?.toISOString() ?? null,
  resolutionDueAt: ticket.resolutionDueAt?.toISOString() ?? null,
  slaBreached: ticket.slaBreached,
  closedAt: ticket.closedAt?.toISOString() ?? null,
  custom: ticket.custom,
  tags: [...tags],
  ...(contact === undefined ? {} : { contact }),
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
});

/**
 * M1-10 added `attachments`. It is a parameter rather than a read here because
 * a thread page resolves every message's attachments in one query; a mapper
 * that fetched its own would be one query per row.
 */
export const toTicketMessage = (
  row: TicketMessageRow,
  attachments: readonly AttachmentRow[] = [],
): TicketMessage => ({
  id: row.id,
  ticketId: row.ticketId,
  seq: row.seq,
  clientId: row.clientId,
  kind: row.kind,
  authorType: row.authorType,
  authorId: row.authorId,
  bodyHtml: row.bodyHtml,
  bodyText: row.bodyText,
  channel: row.channel,
  attachments: attachments.map(toAttachment),
  createdAt: row.createdAt.toISOString(),
});

export const toTicketActivity = (row: TicketActivityRow): TicketActivityEntry => ({
  id: row.id,
  ticketId: row.ticketId,
  actorType: row.actorType,
  actorId: row.actorId,
  action: row.action,
  from: row.from,
  to: row.to,
  via: row.via,
  createdAt: row.createdAt.toISOString(),
});
