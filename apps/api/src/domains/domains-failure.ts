import type { DomainsRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A custom-domain action refused by a rule rather than by a permission
 * (M5-07). The same shape as `channels/channels-failure.ts`: the Domains tab
 * picks its sentence from `reason`; the messages below are for the log and for
 * `curl`.
 */

const STATUS_BY_REASON: Readonly<Record<DomainsRefusal, number>> = {
  'domain-invalid': HttpStatus.BAD_REQUEST,
  'domain-not-public': HttpStatus.BAD_REQUEST,
  'domain-reserved': HttpStatus.CONFLICT,
  'domain-taken': HttpStatus.CONFLICT,
  'domain-limit': HttpStatus.CONFLICT,
  'domain-not-verified': HttpStatus.CONFLICT,
};

const MESSAGE_BY_REASON: Readonly<Record<DomainsRefusal, string>> = {
  'domain-invalid': 'That is not a host name',
  'domain-not-public': 'That host name can never be reached from the internet',
  'domain-reserved': 'That host name is one of this install’s own',
  'domain-taken': 'That host name is already in use',
  'domain-limit': 'This brand has as many help center domains as it may have',
  'domain-not-verified': 'Only a verified domain can be the primary one',
};

export class DomainsFailure extends HttpException {
  readonly reason: DomainsRefusal;

  constructor(reason: DomainsRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'DomainsFailure';
    this.reason = reason;
  }
}
