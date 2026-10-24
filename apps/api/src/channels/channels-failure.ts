import type { ChannelsRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A mailbox action refused by a rule rather than by a permission (M2-08). The
 * same shape as `brands/ticketing-failure.ts`: the status is true but is not a
 * sentence, so the Channels screen picks its words from `reason`. The messages
 * below are for the log and for `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<ChannelsRefusal, number>> = {
  'address-taken': HttpStatus.CONFLICT,
  'password-required': HttpStatus.BAD_REQUEST,
  'department-not-found': HttpStatus.NOT_FOUND,
};

const MESSAGE_BY_REASON: Readonly<Record<ChannelsRefusal, string>> = {
  'address-taken': 'Another mailbox already receives mail for that address',
  'password-required':
    'The IMAP password is only used with the server it was saved for; type it again',
  'department-not-found': 'No such department in this brand',
};

export class ChannelsFailure extends HttpException {
  readonly reason: ChannelsRefusal;
  /** The request field a form draws the refusal on, when it is about one. */
  readonly field: string | undefined;

  constructor(reason: ChannelsRefusal, field?: string) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'ChannelsFailure';
    this.reason = reason;
    this.field = field;
  }
}
