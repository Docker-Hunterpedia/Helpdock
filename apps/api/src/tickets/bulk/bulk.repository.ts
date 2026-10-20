import {
  type DbTransaction,
  type NewTicketBulkOperationItem,
  type TicketBulkOperation,
  type TicketBulkOperationItem,
  ticketBulkOperationItems,
  ticketBulkOperations,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import { asc, eq, inArray, sql } from 'drizzle-orm';

/**
 * M14-03's rows: the operation log and the locks a batch takes. Stateless:
 * every method takes the request's transaction, which carries the tenant scope,
 * so a ticket of another department is simply not here.
 */
export class BulkRepository {
  /**
   * Locks the named tickets that are visible to the caller, in id order, and
   * returns their ids in that order. Every writer of more than one ticket takes
   * its locks in this order, so two batches that overlap wait for each other
   * rather than deadlocking; a single edit holds one ticket and cannot close a
   * cycle with them.
   */
  async lockTickets(tx: DbTransaction, ids: readonly string[]): Promise<string[]> {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(inArray(tickets.id, [...ids]))
      .orderBy(asc(tickets.id))
      .for('update');

    return rows.map((row) => row.id);
  }

  /** The brand's Closed status, which "close" in a bulk edit moves to. */
  async closedStatusId(tx: DbTransaction): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.systemKey, 'closed'))
      .limit(1);

    return row?.id;
  }

  /**
   * Runs `fn` inside a savepoint so one ticket's refusal, or a preview, leaves
   * nothing behind. `fn` says whether to keep what it wrote; an error always
   * rolls back to the savepoint (a failed statement would otherwise leave the
   * whole transaction aborted) and is rethrown for the caller to classify.
   */
  async withSavepoint<T>(
    tx: DbTransaction,
    fn: () => Promise<{ readonly value: T; readonly keep: boolean }>,
  ): Promise<T> {
    await tx.execute(sql`SAVEPOINT bulk_ticket`);
    try {
      const { value, keep } = await fn();
      await tx.execute(
        keep ? sql`RELEASE SAVEPOINT bulk_ticket` : sql`ROLLBACK TO SAVEPOINT bulk_ticket`,
      );
      if (!keep) {
        await tx.execute(sql`RELEASE SAVEPOINT bulk_ticket`);
      }

      return value;
    } catch (error) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT bulk_ticket`);
      await tx.execute(sql`RELEASE SAVEPOINT bulk_ticket`);
      throw error;
    }
  }

  async insertOperation(
    tx: DbTransaction,
    row: {
      readonly id: string;
      readonly brandId: string;
      readonly actorId: string;
      readonly changes: Record<string, unknown>;
      readonly ticketCount: number;
      readonly undoUntil: Date;
    },
  ): Promise<void> {
    await tx.insert(ticketBulkOperations).values(row);
  }

  async insertItems(tx: DbTransaction, rows: readonly NewTicketBulkOperationItem[]): Promise<void> {
    if (rows.length > 0) {
      await tx.insert(ticketBulkOperationItems).values([...rows]);
    }
  }

  /** One operation, locked so two Undos of it cannot both run. Invisible unless it is the caller's. */
  async lockOperation(
    tx: DbTransaction,
    operationId: string,
  ): Promise<TicketBulkOperation | undefined> {
    const [row] = await tx
      .select()
      .from(ticketBulkOperations)
      .where(eq(ticketBulkOperations.id, operationId))
      .limit(1)
      .for('update');

    return row;
  }

  /** The items the caller can still see: a ticket moved out of their sight takes its item with it. */
  itemsOf(tx: DbTransaction, operationId: string): Promise<TicketBulkOperationItem[]> {
    return tx
      .select()
      .from(ticketBulkOperationItems)
      .where(eq(ticketBulkOperationItems.operationId, operationId))
      .orderBy(asc(ticketBulkOperationItems.ticketId));
  }

  async markUndone(tx: DbTransaction, operationId: string, at: Date): Promise<void> {
    await tx
      .update(ticketBulkOperations)
      .set({ undoneAt: at })
      .where(eq(ticketBulkOperations.id, operationId));
  }

  /** The fields an Undo put back on one item, which decides whose notification it withdraws. */
  async markReverted(tx: DbTransaction, itemId: string, fields: readonly string[]): Promise<void> {
    await tx
      .update(ticketBulkOperationItems)
      .set({ reverted: [...fields] })
      .where(eq(ticketBulkOperationItems.id, itemId));
  }
}
