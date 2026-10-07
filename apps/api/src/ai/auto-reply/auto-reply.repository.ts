import {
  type DbTransaction,
  type TicketMessage as TicketMessageRow,
  type Ticket as TicketRow,
  type TicketStatus as TicketStatusRow,
  ticketMessages,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import { and, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { StoredAiMeta } from './ai-meta.js';

/** What auto-reply reads and writes about one conversation, each method in the caller's transaction. */

export interface ConversationRow {
  readonly ticket: TicketRow;
  readonly status: TicketStatusRow;
}

export class AutoReplyRepository {
  async conversation(tx: DbTransaction, ticketId: string): Promise<ConversationRow | undefined> {
    const [row] = await tx
      .select({ ticket: tickets, status: ticketStatuses })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(eq(tickets.id, ticketId))
      .limit(1);
    return row;
  }

  async message(tx: DbTransaction, messageId: string): Promise<TicketMessageRow | undefined> {
    const [row] = await tx
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.id, messageId))
      .limit(1);
    return row;
  }

  /** The customer's newest public message, which is the one a new ticket's job answers. */
  async latestCustomerMessage(
    tx: DbTransaction,
    ticketId: string,
  ): Promise<TicketMessageRow | undefined> {
    const [row] = await tx
      .select()
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          eq(ticketMessages.kind, 'public'),
          eq(ticketMessages.authorType, 'contact'),
        ),
      )
      .orderBy(desc(ticketMessages.seq))
      .limit(1);
    return row;
  }

  /**
   * Whether anything after `seq` makes this job's answer stale: a newer
   * customer message (its own job answers it) or a person's public reply.
   */
  async supersededAfter(tx: DbTransaction, ticketId: string, seq: number): Promise<boolean> {
    const [row] = await tx
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          gt(ticketMessages.seq, seq),
          eq(ticketMessages.kind, 'public'),
          inArray(ticketMessages.authorType, ['contact', 'staff']),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** The customer's and the assistant's messages up to `seq`, oldest first. */
  async turns(
    tx: DbTransaction,
    ticketId: string,
    seq: number,
    limit: number,
  ): Promise<TicketMessageRow[]> {
    const rows = await tx
      .select()
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          lte(ticketMessages.seq, seq),
          or(
            and(eq(ticketMessages.kind, 'public'), eq(ticketMessages.authorType, 'contact')),
            and(eq(ticketMessages.kind, 'ai'), eq(ticketMessages.authorType, 'ai')),
          ),
        ),
      )
      .orderBy(desc(ticketMessages.seq))
      .limit(limit);
    return rows.reverse();
  }

  /** DOMAIN-RULES §15: the first time the assistant answered or handed off here. */
  async markEligible(tx: DbTransaction, ticketId: string, at: Date): Promise<void> {
    await tx
      .update(tickets)
      .set({
        aiEligibleAt: sql`coalesce(${tickets.aiEligibleAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(tickets.id, ticketId));
  }

  async markAnswered(tx: DbTransaction, ticketId: string, at: Date): Promise<void> {
    await tx
      .update(tickets)
      .set({
        aiAnsweredAt: sql`coalesce(${tickets.aiAnsweredAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(tickets.id, ticketId));
  }

  /** The customer's "Was this helpful?", kept in the answer's own `ai_meta`. */
  async saveFeedback(tx: DbTransaction, messageId: string, meta: StoredAiMeta): Promise<void> {
    await tx.update(ticketMessages).set({ aiMeta: meta }).where(eq(ticketMessages.id, messageId));
  }
}
