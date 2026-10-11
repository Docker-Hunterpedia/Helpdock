import type { MetaRefusal, MetaRefusalDetails } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A Meta channel action refused by a rule or by Graph rather than by a
 * permission (M10-02), shaped as `TelegramFailure` is: the screen picks its
 * words from `reason`; the messages below are for the log and for `curl`.
 *
 * `reply-window-closed` is the one refusal that says more than why. The composer
 * needs the platform and when the window closed to tell an agent what they can
 * do instead, so those travel as `details` (ADR 0025, 8).
 */

const STATUS_BY_REASON: Readonly<Record<MetaRefusal, number>> = {
  'token-invalid': HttpStatus.BAD_REQUEST,
  // Not a 5xx: the install is fine, the other side did not answer.
  'graph-unreachable': HttpStatus.CONFLICT,
  'account-taken': HttpStatus.CONFLICT,
  'token-other-account': HttpStatus.BAD_REQUEST,
  'department-not-found': HttpStatus.NOT_FOUND,
  'app-not-configured': HttpStatus.CONFLICT,
  'platform-mismatch': HttpStatus.BAD_REQUEST,
  'reply-window-closed': HttpStatus.CONFLICT,
  'subscribe-failed': HttpStatus.CONFLICT,
};

const MESSAGE_BY_REASON: Readonly<Record<MetaRefusal, string>> = {
  'token-invalid': 'Meta does not recognise that token',
  'graph-unreachable': 'Meta could not be reached to check the token',
  'account-taken': 'That account is already connected to a brand on this install',
  'token-other-account': 'The new token belongs to a different account',
  'department-not-found': 'No such department in this brand',
  'app-not-configured': 'The install has no Meta app secret yet',
  'platform-mismatch': 'The token is for a different platform than the account',
  'reply-window-closed': "The customer's reply window is closed",
  'subscribe-failed': 'Meta refused to subscribe the app to the account',
};

export class MetaFailure extends HttpException {
  readonly reason: MetaRefusal;
  readonly details: MetaRefusalDetails | undefined;

  constructor(reason: MetaRefusal, details?: MetaRefusalDetails) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'MetaFailure';
    this.reason = reason;
    this.details = details;
  }
}
