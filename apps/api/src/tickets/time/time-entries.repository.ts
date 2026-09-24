import { type DbTransaction, type TicketTimeEntry, ticketTimeEntries, users } from '@helpdock/db';
import { desc, eq, sql } from 'drizzle-orm';

/**
 * `ticket_time_entries`, always in the caller's transaction: the department
 * policy decides which tickets' time can be read or written (DOMAIN-RULES
 * §1.3), so nothing here filters by brand or department.
 */

export interface TimeEntryRow {
  readonly entry: TicketTimeEntry;
  readonly userName: string;
}

export class TimeEntriesRepository {
  /** Newest first, with the name each row prints. */
  async list(tx: DbTransaction, ticketId: string): Promise<TimeEntryRow[]> {
    const rows = await tx
      .select({ entry: ticketTimeEntries, userName: users.name })
      .from(ticketTimeEntries)
      .innerJoin(users, eq(users.id, ticketTimeEntries.userId))
      .where(eq(ticketTimeEntries.ticketId, ticketId))
      .orderBy(desc(ticketTimeEntries.createdAt), desc(ticketTimeEntries.id));

    return rows;
  }

  /**
   * The total over every entry, not over the page the card shows: the header
   * prints the ticket's time, and a sum of the visible rows would shrink when a
   * later milestone pages the list.
   */
  async total(tx: DbTransaction, ticketId: string): Promise<number> {
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${ticketTimeEntries.seconds}), 0)::int` })
      .from(ticketTimeEntries)
      .where(eq(ticketTimeEntries.ticketId, ticketId));

    return row?.total ?? 0;
  }

  async insert(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly ticketId: string;
      readonly departmentId: string;
      readonly userId: string;
      readonly seconds: number;
      readonly note: string | null;
      readonly messageId: string | null;
    },
  ): Promise<TicketTimeEntry> {
    const [row] = await tx.insert(ticketTimeEntries).values(values).returning();
    /* c8 ignore next 3 -- an insert that did not throw returned its row. */
    if (row === undefined) {
      throw new Error('Inserting a time entry returned no row');
    }

    return row;
  }

  async find(tx: DbTransaction, entryId: string): Promise<TicketTimeEntry | undefined> {
    const [row] = await tx
      .select()
      .from(ticketTimeEntries)
      .where(eq(ticketTimeEntries.id, entryId))
      .limit(1);

    return row;
  }

  async delete(tx: DbTransaction, entryId: string): Promise<void> {
    await tx.delete(ticketTimeEntries).where(eq(ticketTimeEntries.id, entryId));
  }
}
