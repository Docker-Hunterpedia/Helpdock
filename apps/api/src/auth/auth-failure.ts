import type { AuthErrorBody, AuthErrorCode } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A sign-in failure the screens have to tell apart.
 *
 * Every other failure in the api answers with a code from `errorCodeSchema`,
 * which says what went wrong to a client in general. That is not enough here:
 * the sign-in screens turn the reason into a translated sentence, and the code
 * screen counts attempts down with it. So the auth code rides inside the same
 * envelope as `error.auth` rather than replacing it, and there is still one
 * body shape for every failure.
 *
 * The messages below are for the log and for `curl`. Nothing a person reads is
 * built from them: the admin renders `error.auth.code` through i18next.
 */

const STATUS_BY_CODE: Readonly<Record<AuthErrorCode, number>> = {
  'invalid-credentials': HttpStatus.UNAUTHORIZED,
  'totp-mismatch': HttpStatus.UNAUTHORIZED,
  'recovery-invalid': HttpStatus.UNAUTHORIZED,
  'challenge-expired': HttpStatus.UNAUTHORIZED,
  // A lock and a rate limit are both "come back later", and both must read the
  // same way from outside so that neither confirms an address exists.
  'totp-locked': HttpStatus.TOO_MANY_REQUESTS,
  unavailable: HttpStatus.TOO_MANY_REQUESTS,
  'no-account': HttpStatus.FORBIDDEN,
};

const MESSAGE_BY_CODE: Readonly<Record<AuthErrorCode, string>> = {
  'invalid-credentials': 'That email and password do not match',
  'totp-mismatch': 'That authentication code does not match',
  'recovery-invalid': 'That recovery code is not valid or has already been used',
  'challenge-expired': 'That sign-in attempt has expired',
  'totp-locked': 'Too many attempts; this account is locked for a short while',
  unavailable: 'Sign-in is unavailable right now',
  'no-account': 'No account on this install matches that identity',
};

export class AuthFailure extends HttpException {
  readonly auth: AuthErrorBody;

  constructor(code: AuthErrorCode, options: { readonly attemptsLeft?: number } = {}) {
    super(MESSAGE_BY_CODE[code], STATUS_BY_CODE[code]);
    this.name = 'AuthFailure';
    this.auth = {
      code,
      ...(options.attemptsLeft === undefined ? {} : { attemptsLeft: options.attemptsLeft }),
    };
  }
}

export const isAuthFailure = (error: unknown): error is AuthFailure => error instanceof AuthFailure;
