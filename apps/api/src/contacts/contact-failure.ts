import type { ContactRefusal, IdentityProblem } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A contact action refused by a rule rather than by a permission, in the shape
 * `staff/staff-failure.ts` established: the status says "conflict" or
 * "forbidden", which is true but is not a sentence, so the body carries a code
 * and the screen picks the catalog key.
 *
 * The messages below are for the log and for `curl`. Nothing a person reads is
 * built from them — and, deliberately, none of them repeats the identifier that
 * was refused: "that address already belongs to somebody" told to a stranger
 * who is guessing addresses is an enumeration oracle (DOMAIN-RULES §4).
 */

const STATUS_BY_REASON: Readonly<Record<ContactRefusal, number>> = {
  'identity-taken': HttpStatus.CONFLICT,
  'identity-invalid': HttpStatus.BAD_REQUEST,
  'last-identity': HttpStatus.CONFLICT,
  'anonymise-forbidden': HttpStatus.FORBIDDEN,
  anonymised: HttpStatus.CONFLICT,
  'domain-taken': HttpStatus.CONFLICT,
  merged: HttpStatus.CONFLICT,
  'merge-self': HttpStatus.BAD_REQUEST,
  'merge-expired': HttpStatus.CONFLICT,
  'merge-blocked': HttpStatus.CONFLICT,
};

const MESSAGE_BY_REASON: Readonly<Record<ContactRefusal, string>> = {
  'identity-taken': 'That identifier already belongs to a contact in this brand',
  'identity-invalid': 'That is not a usable identifier of that kind',
  'last-identity': 'A contact keeps at least one identifier',
  'anonymise-forbidden': 'Only an administrator of this brand may erase a contact',
  anonymised: 'This contact has been erased and can no longer be changed',
  'domain-taken': 'Another account of this brand already claims that domain',
  merged: 'This contact was merged into another; change that one instead',
  'merge-self': 'A contact cannot be merged into itself',
  'merge-expired': 'This merge can no longer be undone',
  'merge-blocked': 'The contacts have changed since this merge, so it cannot be undone',
};

export class ContactFailure extends HttpException {
  readonly reason: ContactRefusal;
  /** Set for `identity-invalid`: which way the value was wrong. */
  readonly problem: IdentityProblem | undefined;

  constructor(reason: ContactRefusal, problem?: IdentityProblem) {
    super(MESSAGE_BY_REASON[reason], STATUS_BY_REASON[reason]);
    this.name = 'ContactFailure';
    this.reason = reason;
    this.problem = problem;
  }
}
