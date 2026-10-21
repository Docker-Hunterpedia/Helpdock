import type { PasskeysRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Moving the install's passkeys refused by a rule (M18-06). The Settings dialog
 * picks its sentence from `reason`; the messages are for the log and for `curl`.
 */
const MESSAGE_BY_REASON: Readonly<Record<PasskeysRefusal, string>> = {
  'not-paused': 'Passkeys are not paused: there is nothing to move',
  'pin-locked': 'HD_AUTH_WEBAUTHN_RP_ID pins the RP ID: change it there',
  'move-blocked': 'Moving the passkeys would lock accounts out: add an authenticator app first',
};

export class PasskeysFailure extends HttpException {
  readonly reason: PasskeysRefusal;

  constructor(reason: PasskeysRefusal) {
    super(MESSAGE_BY_REASON[reason], HttpStatus.CONFLICT);
    this.name = 'PasskeysFailure';
    this.reason = reason;
  }
}
