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
  'password-required': 'An IMAP mailbox needs a password, and none is stored yet',
  'department-not-found': 'No such department in this brand',
};

export class ChannelsFailure extends HttpException {
  readonly reason: ChannelsRefusal;

  constructor(reason: ChannelsRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'ChannelsFailure';
    this.reason = reason;
  }
}
