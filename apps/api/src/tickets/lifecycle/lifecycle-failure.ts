import type { TicketLifecycleRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A transition DOMAIN-RULES §2.2 has no row for.
 *
 * The same shape as `brands/ticketing-failure.ts` and `staff/staff-failure.ts`,
 * and for the same reason: 409 is true of all three refusals and is not a
 * sentence. The ticket workspace has three things to say — this ticket belongs
 * to the one it was merged into, this ticket is deleted, this ticket was never
 * closed — and it picks between them on the code, so no English a person reads
 * crosses the api boundary.
 *
 * All three are **409 Conflict** rather than 403: nothing here is about
 * permission. The actor may work this ticket; the ticket is in a state where
 * the request does not apply.
 *
 * The messages below are for the log and for `curl`.
 */
const MESSAGE_BY_REASON: Readonly<Record<TicketLifecycleRefusal, string>> = {
  'ticket-merged': 'This ticket was merged into another one; act on that one instead',
  'ticket-deleted': 'This ticket is deleted',
  'ticket-not-closed': 'This ticket is not closed, so there is nothing to reopen',
  'ticket-not-spam': 'This ticket is not marked as spam',
};

export class TicketLifecycleFailure extends HttpException {
  readonly reason: TicketLifecycleRefusal;

  constructor(reason: TicketLifecycleRefusal) {
    super(MESSAGE_BY_REASON[reason], HttpStatus.CONFLICT);
    this.name = 'TicketLifecycleFailure';
    this.reason = reason;
  }
}
