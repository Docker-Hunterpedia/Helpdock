import type { TicketingRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A ticketing-settings action refused by a rule rather than by a permission.
 *
 * The same shape as `staff/staff-failure.ts`, and for the same reason: the
 * status says "forbidden" or "conflict", which is true but is not a sentence.
 * The Ticketing screen has eleven things to say — you do not lead that
 * department, a brand keeps one department, tickets still point at it, that
 * name is taken, that person cannot reach this department, rows already carry
 * values of that field, rows still carry that option, and the four M1-08 adds
 * about a status row — and it picks between them on this code.
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
  // M1-08's four. All conflicts: the actor holds `ticketing:manage`, and what
  // refuses is the shape of the status list rather than their permission.
  'status-is-system': HttpStatus.CONFLICT,
  'status-is-default': HttpStatus.CONFLICT,
  'status-state-fixed': HttpStatus.CONFLICT,
  'default-must-be-open': HttpStatus.CONFLICT,
  'field-in-use': HttpStatus.CONFLICT,
  'option-in-use': HttpStatus.CONFLICT,
  // M1-07. A ceiling on who the actor may act on, which is a permission answer.
  'assignee-above-actor': HttpStatus.FORBIDDEN,
};

const MESSAGE_BY_REASON: Readonly<Record<TicketingRefusal, string>> = {
  'out-of-scope': 'That department is outside the ones you lead',
  'last-department': 'A brand keeps at least one department for tickets to be filed under',
  'department-in-use': 'Tickets still belong to this department; move them first',
  'name-taken': 'Another one of this brand already has that name',
  'not-eligible': 'That person holds no role in this brand that reaches this department',
  'status-is-system': 'A seeded status may be renamed and recoloured, never deleted',
  'status-is-default': 'Make another status the default before deleting this one',
  'status-state-fixed': "A seeded status's system state and flags are what code refers to it by",
  'default-must-be-open':
    'The default status is where a new or reopened ticket lands, so it has to be open',
  'field-in-use': 'Rows already carry values for this field, so its type cannot change',
  'option-in-use': 'Rows still carry that option; send force to clear them with it',
  'assignee-above-actor': 'Only an Admin may route work to an Admin',
};

export class TicketingFailure extends HttpException {
  readonly reason: TicketingRefusal;

  constructor(reason: TicketingRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'TicketingFailure';
    this.reason = reason;
  }
}
