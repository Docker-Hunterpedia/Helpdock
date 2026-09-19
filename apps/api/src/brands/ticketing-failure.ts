import type { TicketingRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A ticketing-settings action refused by a rule rather than by a permission.
 *
 * The same shape as `staff/staff-failure.ts`, and for the same reason: the
 * status says "forbidden" or "conflict", which is true but is not a sentence.
 * The Ticketing screen has five things to say — you do not lead that
 * department, a brand keeps one department, tickets still point at it, that
 * name is taken, that person cannot reach this department — and it picks
 * between them on this code.
 *
 * The messages below are for the log and for `curl`. Nothing a person reads is
 * built from them.
 */

const STATUS_BY_REASON: Readonly<Record<TicketingRefusal, number>> = {
  // A scope failure is a permission answer, and permission answers are 403.
  'out-of-scope': HttpStatus.FORBIDDEN,
  'last-department': HttpStatus.CONFLICT,
  'department-in-use': HttpStatus.CONFLICT,
  'name-taken': HttpStatus.CONFLICT,
  'not-eligible': HttpStatus.CONFLICT,
};

const MESSAGE_BY_REASON: Readonly<Record<TicketingRefusal, string>> = {
  'out-of-scope': 'That department is outside the ones you lead',
  'last-department': 'A brand keeps at least one department for tickets to be filed under',
  'department-in-use': 'Tickets still belong to this department; move them first',
  'name-taken': 'Another one of this brand already has that name',
  'not-eligible': 'That person holds no role in this brand that reaches this department',
};

export class TicketingFailure extends HttpException {
  readonly reason: TicketingRefusal;

  constructor(reason: TicketingRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'TicketingFailure';
    this.reason = reason;
  }
}
