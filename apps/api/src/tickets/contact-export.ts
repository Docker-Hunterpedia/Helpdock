import {
  attachments,
  type DbTransaction,
  ticketMessages,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import type { ContactExportTicket } from '@helpdock/schemas';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ContactExportProvider } from '../contacts/providers.js';

/**
 * The ticket half of a contact export (ASVS 8.3.2): every ticket of the
 * contact, with the conversation as the contact saw it and the files in it.
 *
 * It lives beside the timeline provider for the reason that one does: tickets
 * know the contact contract, contacts know nothing about the ticket schema.
 *
 * Only what the contact could read is included — public replies, AI answers
 * and system lines. An internal note is the team's working paper about the
 * conversation, not part of it, and is never read here. A merged-away ticket
 * keeps its own messages and is listed on its own; the caller's transaction
 * decides which tickets are visible, and the service only lets an Admin, who
 * sees every department, ask.
 */

const CONVERSATION_KINDS = ['public', 'ai', 'system'] as const;

const downloadPath = (brandId: string, ticketId: string, attachmentId: string): string =>
  `/api/brands/${brandId}/tickets/${ticketId}/attachments/${attachmentId}`;

export class DbContactExportProvider implements ContactExportProvider {
  async ticketsOf(
    tx: DbTransaction,
    brandId: string,
    contactId: string,
  ): Promise<ContactExportTicket[]> {
    const ticketRows = await tx
      .select({
        id: tickets.id,
        prefix: tickets.prefix,
        number: tickets.number,
        subject: tickets.subject,
        channel: tickets.channel,
        status: ticketStatuses.name,
        createdAt: tickets.createdAt,
        closedAt: tickets.closedAt,
      })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(eq(tickets.contactId, contactId))
      .orderBy(asc(tickets.createdAt), asc(tickets.id));

    if (ticketRows.length === 0) {
      return [];
    }

    const ticketIds = ticketRows.map((row) => row.id);
    const messageRows = await tx
      .select({
        id: ticketMessages.id,
        ticketId: ticketMessages.ticketId,
        seq: ticketMessages.seq,
        authorType: ticketMessages.authorType,
        bodyText: ticketMessages.bodyText,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(
        and(
          inArray(ticketMessages.ticketId, ticketIds),
          inArray(ticketMessages.kind, [...CONVERSATION_KINDS]),
        ),
      )
      .orderBy(asc(ticketMessages.ticketId), asc(ticketMessages.seq));

    const fileRows =
      messageRows.length === 0
        ? []
        : await tx
            .select({
              id: attachments.id,
              ticketId: attachments.ticketId,
              messageId: attachments.messageId,
              name: attachments.originalName,
              mime: attachments.mime,
              size: attachments.size,
            })
            .from(attachments)
            .where(
              and(
                inArray(
                  attachments.messageId,
                  messageRows.map((row) => row.id),
                ),
                eq(attachments.status, 'ready'),
              ),
            )
            .orderBy(asc(attachments.createdAt), asc(attachments.id));

    const filesByMessage = Map.groupBy(fileRows, (row) => row.messageId);
    const messagesByTicket = Map.groupBy(messageRows, (row) => row.ticketId);

    return ticketRows.map((ticket) => ({
      id: ticket.id,
      reference: `${ticket.prefix}-${ticket.number}`,
      subject: ticket.subject,
      channel: ticket.channel,
      status: ticket.status,
      createdAt: ticket.createdAt.toISOString(),
      closedAt: ticket.closedAt?.toISOString() ?? null,
      messages: (messagesByTicket.get(ticket.id) ?? []).map((message) => ({
        id: message.id,
        seq: message.seq,
        author: message.authorType,
        bodyText: message.bodyText,
        createdAt: message.createdAt.toISOString(),
        attachments: (filesByMessage.get(message.id) ?? []).map((file) => ({
          id: file.id,
          name: file.name,
          mime: file.mime,
          size: file.size,
          downloadPath: downloadPath(brandId, file.ticketId, file.id),
        })),
      })),
    }));
  }
}
