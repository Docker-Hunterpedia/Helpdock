import type {
  TicketActivityEntry as TicketActivityRow,
  TicketMessage as TicketMessageRow,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import type { Ticket, TicketActivityEntry, TicketMessage, TicketStatus } from '@helpdock/schemas';

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

export const toTicketStatus = (row: TicketStatusRow): TicketStatus => ({
  id: row.id,
  name: row.name,
  nameAr: row.nameAr,
  systemState: row.systemState,
  pausesSla: row.pausesSla,
  awaitingCustomer: row.awaitingCustomer,
  isDefault: row.isDefault,
  isSystem: row.isSystem,
  sortOrder: row.sortOrder,
  color: row.color,
});

export const toTicket = (ticket: TicketRow, status: TicketStatusRow): Ticket => ({
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
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
});

export const toTicketMessage = (row: TicketMessageRow): TicketMessage => ({
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
