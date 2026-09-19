import { type DbTransaction, tickets } from '@helpdock/db';
import { count, eq } from 'drizzle-orm';
import { TicketingFailure } from './ticketing-failure.js';

/**
 * The two reasons a department may not be deleted.
 *
 * | Reason | Refusal |
 * |---|---|
 * | It is the brand's last department | `last-department` |
 * | Tickets still point at it | `department-in-use` |
 *
 * Both answer the same question — "would this leave something with nowhere to
 * go?" — so they live together rather than one in the service and one in a
 * query somebody remembers to write.
 */

export interface DepartmentDeletionContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly departmentId: string;
}

/**
 * How many tickets would be orphaned by deleting this department.
 *
 * It runs in the caller's own transaction, so the two row-level security layers
 * of DOMAIN-RULES §1.3 both apply: `tickets` is brand-scoped *and*
 * department-scoped, which means an Admin (`app.all_departments`) counts every
 * ticket in the department, while a principal who cannot see the department
 * counts none.
 *
 * That asymmetry is safe here because **deleting a department is
 * `brand:manage`**, which only an Admin holds (`department-scope.ts`), and an
 * Admin's scope is always `'all'`. Nobody who could be shown a zero is allowed
 * to act on it.
 *
 * Soft-deleted tickets are counted too: DOMAIN-RULES §2.2 hides them from
 * views until retention purges them, and a department deleted underneath one
 * would leave a row that cannot be restored to anywhere.
 */
export const ticketsInDepartment = async ({
  tx,
  departmentId,
}: DepartmentDeletionContext): Promise<number> => {
  const rows = await tx
    .select({ total: count() })
    .from(tickets)
    .where(eq(tickets.departmentId, departmentId));

  return rows[0]?.total ?? 0;
};

export interface DepartmentDeletionOptions {
  /**
   * How many departments the brand would still have. Counted by the caller
   * inside the same transaction, so the number cannot be stale by the time it
   * is acted on.
   */
  readonly remainingDepartments: number;
  /** How the ticket count is taken. A seam for the unit suite, which has no database. */
  readonly countTickets?: (context: DepartmentDeletionContext) => Promise<number>;
}

/** Refuses a delete that would break something. */
export const assertDepartmentDeletable = async (
  context: DepartmentDeletionContext,
  { remainingDepartments, countTickets = ticketsInDepartment }: DepartmentDeletionOptions,
): Promise<void> => {
  // A brand with no department has nowhere to file a ticket, and nothing in the
  // product can create one back except an administrator noticing. Checked
  // first, because it costs no query.
  if (remainingDepartments < 1) {
    throw new TicketingFailure('last-department');
  }

  if ((await countTickets(context)) > 0) {
    throw new TicketingFailure('department-in-use');
  }
};
