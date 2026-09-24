import {
  type Attachment as AttachmentRow,
  attachments,
  type DbTransaction,
  type TicketMessage as TicketMessageRow,
  type Ticket as TicketRow,
  type TicketStatus as TicketStatusRow,
  ticketMessages,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import type { TicketLink } from '@helpdock/schemas';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';

/**
 * The statements merge, unmerge and split make that `tickets.repository.ts`
 * does not already.
 *
 * The rule of that file holds here: **nothing filters by brand or
 * department**. The request's transaction carries the scope and the policies
 * of DOMAIN-RULES §1.3 apply it, so a ticket in another department is simply
 * not among the rows — which is what makes "a ticket the actor cannot read
 * answers exactly like a nonexistent one" true of a merge's primary too.
 */

/**
 * How deep a chain of merges is followed. A chain is built one deliberate merge
 * at a time and a primary can never be merged into its own secondary, so this
 * is a guard against a bug rather than a limit anybody reaches.
 */
const MAX_CHAIN_DEPTH = 32;

const linkColumns = {
  id: tickets.id,
  number: tickets.number,
  prefix: tickets.prefix,
  subject: tickets.subject,
};

export class MergeRepository {
  /**
   * Locks the named tickets, in id order so two merges of the same pair in
   * opposite directions queue rather than deadlock. A ticket the transaction
   * cannot see is not locked, and the caller's read then answers 404 for it.
   */
  async lockTickets(tx: DbTransaction, ticketIds: readonly string[]): Promise<void> {
    await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(inArray(tickets.id, [...new Set(ticketIds)]))
      .orderBy(asc(tickets.id))
      .for('update');
  }

  /** The row §2.4 closes a secondary into, found by the key code owns. */
  async mergedStatus(tx: DbTransaction): Promise<TicketStatusRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.systemKey, 'merged'))
      .limit(1);

    return rows[0];
  }

  /**
   * Every ticket merged into `primaryId`, directly or through a chain, oldest
   * merge first. One query per level, and a chain is rarely more than one.
   */
  async mergedInto(tx: DbTransaction, primaryId: string): Promise<TicketRow[]> {
    const found: TicketRow[] = [];
    let frontier = [primaryId];

    for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length > 0; depth += 1) {
      const level = await tx
        .select()
        .from(tickets)
        .where(and(inArray(tickets.mergedIntoId, frontier), isNull(tickets.deletedAt)))
        .orderBy(asc(tickets.mergedAt), asc(tickets.id));

      found.push(...level);
      frontier = level.map((ticket) => ticket.id);
    }

    return found;
  }

  /** One ticket as a link, or `undefined` when the transaction cannot see it. */
  async link(tx: DbTransaction, ticketId: string): Promise<TicketLink | undefined> {
    const rows = await tx
      .select(linkColumns)
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);

    return rows[0];
  }

  /**
   * The tickets a split joined to this one: the one it was split from, and the
   * ones split from it. Each is read under the caller's scope, so a split into
   * a department the reader cannot see is simply not linked.
   */
  async splitRelated(tx: DbTransaction, ticket: TicketRow): Promise<TicketLink[]> {
    const splitFrom = ticket.splitFromId === null ? [] : [eq(tickets.id, ticket.splitFromId)];

    return tx
      .select(linkColumns)
      .from(tickets)
      .where(and(or(eq(tickets.splitFromId, ticket.id), ...splitFrom), isNull(tickets.deletedAt)))
      .orderBy(asc(tickets.number));
  }

  /** The named messages of one ticket; ids of any other ticket are not found. */
  async messagesOfTicket(
    tx: DbTransaction,
    ticketId: string,
    messageIds: readonly string[],
  ): Promise<TicketMessageRow[]> {
    return tx
      .select()
      .from(ticketMessages)
      .where(
        and(eq(ticketMessages.ticketId, ticketId), inArray(ticketMessages.id, [...messageIds])),
      );
  }

  /**
   * Copies of attachments onto a split's copied message. The object is shared,
   * so `s3_key` and `variants` are the original's; `ticket_id`, `message_id`
   * and — through the trigger — `department_id` are the new ticket's, which is
   * what authorises a download through the copy.
   */
  async insertAttachmentCopies(
    tx: DbTransaction,
    target: {
      readonly brandId: string;
      readonly ticketId: string;
      readonly messageId: string;
      readonly departmentId: string;
    },
    originals: readonly AttachmentRow[],
  ): Promise<void> {
    if (originals.length === 0) {
      return;
    }

    await tx.insert(attachments).values(
      originals.map((original) => ({
        brandId: target.brandId,
        ticketId: target.ticketId,
        departmentId: target.departmentId,
        messageId: target.messageId,
        uploaderType: original.uploaderType,
        uploaderId: original.uploaderId,
        s3Key: original.s3Key,
        originalName: original.originalName,
        mime: original.mime,
        size: original.size,
        kind: original.kind,
        status: original.status,
        rejectReason: original.rejectReason,
        variants: original.variants,
        scanStatus: original.scanStatus,
        processedAt: original.processedAt,
        createdAt: original.createdAt,
        copiedFromAttachmentId: original.copiedFromAttachmentId ?? original.id,
      })),
    );
  }
}
