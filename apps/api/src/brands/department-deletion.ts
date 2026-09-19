import type { DbTransaction } from '@helpdock/db';
import { TicketingFailure } from './ticketing-failure.js';

/**
 * The two reasons a department may not be deleted, named as calls rather than
 * left as a comment — the shape `staff/lifecycle-hooks.ts` uses, and for the
 * same reason: it puts the missing work at the exact point in the sequence
 * where it has to happen.
 *
 * | Reason | Owner |
 * |---|---|
 * | It is the brand's last department | M1-01, below |
 * | Tickets still point at it | M1-02, once `tickets` exists |
 *
 * The second is a real refusal with nothing to check yet. `tickets` has no
 * table until M1-02, so counting would mean querying a relation that does not
 * exist; the hook answers "nothing references it" and the deliverable that
 * creates the table replaces the body with the count. Everything around it —
 * the refusal code, the status, the sentence the screen prints, the test that
 * proves the route answers 409 — is already here, so the change is one
 * function.
 */

export interface DepartmentDeletionContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly departmentId: string;
}

/**
 * How many tickets would be orphaned by deleting this department.
 *
 * **M1-02 fills this in.** Replace the body with a count over `tickets` in the
 * request's own transaction — row-level security already narrows it to the
 * brand — and `assertDepartmentDeletable` starts refusing without any other
 * change. The Ticketing screen already draws the refusal, and
 * `department-deletion.test.ts` already asserts it.
 */
export const ticketsInDepartment = (_context: DepartmentDeletionContext): Promise<number> =>
  Promise.resolve(0);

export interface DepartmentDeletionOptions {
  /**
   * How many departments the brand would still have. Counted by the caller
   * inside the same transaction, so the number cannot be stale by the time it
   * is acted on.
   */
  readonly remainingDepartments: number;
  /**
   * How the ticket count is taken. A parameter so the refusal can be tested
   * before `tickets` exists; M1-02 changes {@link ticketsInDepartment}, not
   * this signature.
   */
  readonly countTickets?: (context: DepartmentDeletionContext) => Promise<number>;
}

/** Refuses a delete that would break something. */
export const assertDepartmentDeletable = async (
  context: DepartmentDeletionContext,
  { remainingDepartments, countTickets = ticketsInDepartment }: DepartmentDeletionOptions,
): Promise<void> => {
  // A brand with no department has nowhere to file a ticket, and nothing in the
  // product can create one back except an administrator noticing.
  if (remainingDepartments < 1) {
    throw new TicketingFailure('last-department');
  }

  if ((await countTickets(context)) > 0) {
    throw new TicketingFailure('department-in-use');
  }
};
