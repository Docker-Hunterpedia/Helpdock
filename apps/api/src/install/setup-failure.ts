import type { SetupRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A first-run wizard step refused by a rule the screen draws on its own line,
 * rather than as the generic "something went wrong" banner. The same shape as
 * `brands/ticketing-failure.ts`; the message is for the log and for `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<SetupRefusal, number>> = {
  // The same status as the `Sec-Fetch-Site` refusal: both say "not from you".
  'setup-key-invalid': HttpStatus.FORBIDDEN,
  // Outgoing email: a changed server needs its password typed again (#369).
  'smtp-password-required': HttpStatus.BAD_REQUEST,
};

const MESSAGE_BY_REASON: Readonly<Record<SetupRefusal, string>> = {
  'setup-key-invalid': 'This install asks for its setup key (HD_SETUP_TOKEN) to create the admin',
  'smtp-password-required':
    'The stored password is only used with the server it was saved for; type it again',
};

/**
 * A call that opens a socket to a host the caller named, refused for the rest
 * of its window. `retryAfter` is seconds, for the `Retry-After` header.
 */
export class SetupThrottled extends HttpException {
  readonly retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'SetupThrottled';
    this.retryAfter = retryAfter;
  }
}

export class SetupFailure extends HttpException {
  readonly reason: SetupRefusal;

  constructor(reason: SetupRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'SetupFailure';
    this.reason = reason;
  }
}
