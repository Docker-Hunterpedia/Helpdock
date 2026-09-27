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
};

const MESSAGE_BY_REASON: Readonly<Record<SetupRefusal, string>> = {
  'setup-key-invalid': 'This install asks for its setup key (HD_SETUP_TOKEN) to create the admin',
};

export class SetupFailure extends HttpException {
  readonly reason: SetupRefusal;

  constructor(reason: SetupRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'SetupFailure';
    this.reason = reason;
  }
}
