import type { StaffRefusal } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A staff action refused by DOMAIN-RULES §12 rather than by a permission.
 *
 * The same shape as `auth/auth-failure.ts`, and for the same reason: the status
 * says "forbidden" or "conflict", which is true but is not a sentence. The
 * staff screen has four things to say — you cannot change your own role, that
 * person is outside your departments, the Viewer role is off, that is the last
 * install admin — and it picks between them on this code.
 *
 * The messages below are for the log and for `curl`. Nothing a person reads is
 * built from them.
 */

const STATUS_BY_REASON: Readonly<Record<StaffRefusal, number>> = {
  self: HttpStatus.CONFLICT,
  // A scope failure is a permission answer, and permission answers are 403.
  'out-of-scope': HttpStatus.FORBIDDEN,
  'viewer-disabled': HttpStatus.CONFLICT,
  'last-install-admin': HttpStatus.CONFLICT,
};

const MESSAGE_BY_REASON: Readonly<Record<StaffRefusal, string>> = {
  self: 'You cannot change or deactivate your own role',
  'out-of-scope': 'That person, or that role, is outside the departments you lead',
  'viewer-disabled': 'The Viewer role is turned off on this install',
  'last-install-admin': 'This is the last install administrator and must keep its access',
};

export class StaffFailure extends HttpException {
  readonly reason: StaffRefusal;

  constructor(reason: StaffRefusal) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'StaffFailure';
    this.reason = reason;
  }
}
