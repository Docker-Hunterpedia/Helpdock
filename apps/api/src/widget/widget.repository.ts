import {
  type Attachment as AttachmentRow,
  attachments,
  type DbTransaction,
  departments,
  type TicketMessage as TicketMessageRow,
  type Ticket as TicketRow,
  type TicketStatus as TicketStatusRow,
  ticketMessages,
  ticketStatuses,
  tickets,
  users,
  type WidgetVisitor,
  widgetVisitors,
} from '@helpdock/db';
import { and, asc, desc, eq, gt, inArray, isNull, lt, max, or, sql } from 'drizzle-orm';

/**
 * The widget's own reads and writes: visitors, and a visitor's view of the
 * tickets that are their conversations. Tickets and messages themselves are
 * written through `TicketRepository` and the lifecycle, as every channel
 * writes them.
 *
 * Every method runs in the brand-scoped system transaction a widget request
 * opens, so the brand policy applies; which *conversations* a visitor may
 * reach is decided by `conversation-access.ts` from what these return.
 */

export interface TicketWithStatus {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
}

/** What a visitor may see of a thread: public replies and AI answers, never notes or system rows. */
const VISITOR_KINDS = ['public', 'ai'] as const;

export class WidgetRepository {
  // ------------------------------------------------------------- visitors

  async visitorByHash(tx: DbTransaction, secretHash: string): Promise<WidgetVisitor | undefined> {
    const [row] = await tx
      .select()
      .from(widgetVisitors)
      .where(eq(widgetVisitors.secretHash, secretHash))
      .limit(1);
    return row;
  }

  async visitorById(tx: DbTransaction, visitorId: string): Promise<WidgetVisitor | undefined> {
    const [row] = await tx
      .select()
      .from(widgetVisitors)
      .where(eq(widgetVisitors.id, visitorId))
      .limit(1);
    return row;
  }

  async insertVisitor(
    tx: DbTransaction,
    values: { readonly brandId: string; readonly secretHash: string },
  ): Promise<WidgetVisitor> {
    const [row] = await tx.insert(widgetVisitors).values(values).returning();
    /* c8 ignore next 3 -- an insert that returns nothing has failed and thrown. */
    if (row === undefined) {
      throw new Error('The visitor insert returned no row');
    }
    return row;
  }

  async updateVisitor(
    tx: DbTransaction,
    visitorId: string,
    values: Partial<Pick<WidgetVisitor, 'contactId' | 'verifiedContactId' | 'lastSeenAt'>>,
  ): Promise<WidgetVisitor> {
    const [row] = await tx
      .update(widgetVisitors)
      .set(values)
      .where(eq(widgetVisitors.id, visitorId))
      .returning();
    /* c8 ignore next 3 -- the visitor was read in this transaction. */
    if (row === undefined) {
      throw new Error('The visitor vanished inside its own transaction');
    }
    return row;
  }

  // -------------------------------------------------------- conversations

  /**
   * The tickets a visitor may be shown, newest first: their own, and — while
   * a signed identity vouches for them — the verified contact's widget
   * conversations, or every channel's when the brand allows it (§4.2).
   * `conversation-access.ts` re-checks each one; this only narrows the scan.
   */
  async conversationsOf(
    tx: DbTransaction,
    visitor: Pick<WidgetVisitor, 'id' | 'verifiedContactId'>,
    allChannels: boolean,
  ): Promise<TicketWithStatus[]> {
    const verified = visitor.verifiedContactId;
    const byContact =
      verified === null
        ? undefined
        : allChannels
          ? eq(tickets.contactId, verified)
          : and(eq(tickets.contactId, verified), eq(tickets.channel, 'chat'));

    const rows = await tx
      .select()
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          isNull(tickets.deletedAt),
          byContact === undefined
            ? eq(tickets.visitorId, visitor.id)
            : or(eq(tickets.visitorId, visitor.id), byContact),
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(50);

    return rows.map((row) => ({ ticket: row.tickets, status: row.ticket_statuses }));
  }

  async conversation(tx: DbTransaction, ticketId: string): Promise<TicketWithStatus | undefined> {
    const [row] = await tx
      .select()
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);
    return row === undefined ? undefined : { ticket: row.tickets, status: row.ticket_statuses };
  }

  /** The conversation this visitor opened with `clientId` (M4-04), if they did. */
  async conversationStartedWith(
    tx: DbTransaction,
    visitorId: string,
    clientId: string,
  ): Promise<TicketWithStatus | undefined> {
    const [row] = await tx
      .select()
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          eq(tickets.visitorId, visitorId),
          eq(tickets.visitorClientId, clientId),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : { ticket: row.tickets, status: row.ticket_statuses };
  }

  /** The newest ticket continuing each of these (§2.3), if any. */
  async continuations(
    tx: DbTransaction,
    ticketIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (ticketIds.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({ id: tickets.id, parentId: tickets.parentId })
      .from(tickets)
      .where(and(inArray(tickets.parentId, [...ticketIds]), isNull(tickets.deletedAt)))
      .orderBy(asc(tickets.createdAt));

    const byParent = new Map<string, string>();
    for (const row of rows) {
      if (row.parentId !== null) {
        byParent.set(row.parentId, row.id);
      }
    }
    return byParent;
  }

  /** The highest `seq` of each ticket, notes included: the catch-up cursor (§7). */
  async lastSeqs(tx: DbTransaction, ticketIds: readonly string[]): Promise<Map<string, number>> {
    if (ticketIds.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({ ticketId: ticketMessages.ticketId, seq: max(ticketMessages.seq) })
      .from(ticketMessages)
      .where(inArray(ticketMessages.ticketId, [...ticketIds]))
      .groupBy(ticketMessages.ticketId);

    return new Map(rows.map((row) => [row.ticketId, row.seq ?? 0]));
  }

  /**
   * Serialises two attempts at the same first message, so a double-submitted
   * start opens one conversation rather than two: the unique index is per
   * ticket, and there is no ticket yet to hang it on.
   */
  async lockClientId(tx: DbTransaction, visitorId: string, clientId: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${visitorId}:${clientId}`}, 0))`,
    );
  }

  /** The visitor-visible thread from a cursor, oldest first, `limit + 1` rows. */
  async visibleMessagesAfter(
    tx: DbTransaction,
    ticketId: string,
    after: number,
    limit: number,
  ): Promise<TicketMessageRow[]> {
    return tx
      .select()
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          gt(ticketMessages.seq, after),
          inArray(ticketMessages.kind, [...VISITOR_KINDS]),
        ),
      )
      .orderBy(asc(ticketMessages.seq))
      .limit(limit + 1);
  }

  async message(tx: DbTransaction, messageId: string): Promise<TicketMessageRow | undefined> {
    const [row] = await tx
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.id, messageId))
      .limit(1);
    return row;
  }

  async attachmentsOf(
    tx: DbTransaction,
    messageIds: readonly string[],
  ): Promise<Map<string, AttachmentRow[]>> {
    const grouped = new Map<string, AttachmentRow[]>();
    if (messageIds.length === 0) {
      return grouped;
    }
    const rows = await tx
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, [...messageIds]))
      .orderBy(asc(attachments.createdAt));
    for (const row of rows) {
      if (row.messageId !== null) {
        grouped.set(row.messageId, [...(grouped.get(row.messageId) ?? []), row]);
      }
    }
    return grouped;
  }

  /** Staff display names by id, for "Lina" on an agent's reply (M4-08). */
  async staffNames(tx: DbTransaction, userIds: readonly string[]): Promise<Map<string, string>> {
    const ids = userIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** The department a new widget conversation is filed in: the brand's first. */
  async firstDepartment(tx: DbTransaction): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: departments.id })
      .from(departments)
      .orderBy(asc(departments.sortOrder), asc(departments.createdAt))
      .limit(1);
    return row?.id;
  }

  /**
   * M4-04's queue position: the unassigned, still-open widget conversations
   * of the same department that were opened before this one, plus one. Null
   * once somebody holds it or it is closed.
   */
  async queuePosition(tx: DbTransaction, entry: TicketWithStatus): Promise<number | null> {
    const { ticket, status } = entry;
    if (ticket.assigneeId !== null || status.systemState === 'closed') {
      return null;
    }
    const [row] = await tx
      .select({ ahead: sql<number>`count(*)::int` })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(
        and(
          eq(tickets.departmentId, ticket.departmentId),
          eq(tickets.channel, 'chat'),
          isNull(tickets.assigneeId),
          isNull(tickets.deletedAt),
          isNull(tickets.mergedIntoId),
          sql`${ticketStatuses.systemState} <> 'closed'`,
          lt(tickets.createdAt, ticket.createdAt),
        ),
      );
    return (row?.ahead ?? 0) + 1;
  }
}
