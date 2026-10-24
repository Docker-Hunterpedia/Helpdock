import type { SsoRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A connection save refused by a rule rather than by a permission. The same
 * shape as `domains/domains-failure.ts`: the connection form picks its sentence
 * from `reason`; the messages below are for the log and for `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<SsoRefusal, number>> = {
  'sso-email-domain-taken': HttpStatus.CONFLICT,
  'sso-metadata-confirm-certificates': HttpStatus.BAD_REQUEST,
  'sso-client-secret-required': HttpStatus.BAD_REQUEST,
};

const MESSAGE_BY_REASON: Readonly<Record<SsoRefusal, string>> = {
  'sso-email-domain-taken': 'Another enabled connection already lists one of these email domains',
  'sso-metadata-confirm-certificates':
    'The identity provider metadata lists a signing certificate that has not been saved',
  'sso-client-secret-required':
    'The stored client secret is only used with the issuer it was saved for; type it again',
};

export class SsoFailure extends HttpException {
  readonly reason: SsoRefusal;
  readonly domains: readonly string[] | undefined;

  constructor(reason: SsoRefusal, domains?: readonly string[]) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'SsoFailure';
    this.reason = reason;
    this.domains = domains;
  }
}
