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
  'sso-email-unverified': HttpStatus.FORBIDDEN,
  'sso-no-access': HttpStatus.FORBIDDEN,
  'sso-connection-disabled': HttpStatus.FORBIDDEN,
  'sso-required': HttpStatus.FORBIDDEN,
  'sso-invalid-response': HttpStatus.UNAUTHORIZED,
  'sso-identity-conflict': HttpStatus.FORBIDDEN,
  'oauth-link-required': HttpStatus.FORBIDDEN,
  'oauth-identity-conflict': HttpStatus.FORBIDDEN,
  'oauth-last-sign-in': HttpStatus.CONFLICT,
  'oauth-domain-not-allowed': HttpStatus.FORBIDDEN,
  'oauth-tenant-mismatch': HttpStatus.FORBIDDEN,
  'invite-expired': HttpStatus.GONE,
  'rate-limited': HttpStatus.TOO_MANY_REQUESTS,
  'invalid-credentials': HttpStatus.UNAUTHORIZED,
  'totp-mismatch': HttpStatus.UNAUTHORIZED,
  'recovery-invalid': HttpStatus.UNAUTHORIZED,
  'challenge-expired': HttpStatus.UNAUTHORIZED,
  // The challenge lock remains separate from the sliding-window refusal.
  'totp-locked': HttpStatus.TOO_MANY_REQUESTS,
  unavailable: HttpStatus.TOO_MANY_REQUESTS,
  // A standing state of the install, not a throttle: no link can be emailed
  // until the install has a system sender (#369).
  'email-unavailable': HttpStatus.SERVICE_UNAVAILABLE,
  'no-account': HttpStatus.FORBIDDEN,
  'password-breached': HttpStatus.BAD_REQUEST,
  'passkeys-unavailable': HttpStatus.FORBIDDEN,
  'passkeys-rp-changed': HttpStatus.CONFLICT,
  'second-factor-required': HttpStatus.CONFLICT,
  'passkey-limit': HttpStatus.CONFLICT,
  'passkey-duplicate': HttpStatus.CONFLICT,
  'totp-already-enabled': HttpStatus.CONFLICT,
  'passkey-invalid': HttpStatus.UNAUTHORIZED,
};

const MESSAGE_BY_CODE: Readonly<Record<AuthErrorCode, string>> = {
  'sso-email-unverified': 'The identity provider did not verify an allowed email address',
  'sso-no-access': 'This identity has no access to an active brand',
  'sso-connection-disabled': 'This single sign-on connection is disabled',
  'sso-required': 'Single sign-on is required',
  'sso-invalid-response': 'The identity provider response is invalid',
  'sso-identity-conflict': 'This account is already linked to another single sign-on identity',
  'oauth-link-required':
    'Sign in another way once, then connect this provider account from the security page',
  'oauth-identity-conflict':
    'That provider account is linked to another person, or this account already has one',
  'oauth-last-sign-in':
    'This provider account is the only way to sign in; set a password or connect another first',
  'oauth-domain-not-allowed':
    'This install accepts Google accounts from its allowed Workspace domains only',
  'oauth-tenant-mismatch':
    'This Microsoft account belongs to a different organisation than the one this install trusts',
  'invite-expired': 'That invitation is no longer valid',
  'rate-limited': 'Too many sign-in attempts',
  'invalid-credentials': 'That email and password do not match',
  'totp-mismatch': 'That authentication code does not match',
  'recovery-invalid': 'That recovery code is not valid or has already been used',
  'challenge-expired': 'That sign-in attempt has expired',
  'totp-locked': 'Too many attempts; this account is locked for a short while',
  unavailable: 'Sign-in is unavailable right now',
  'email-unavailable':
    'This install has no outgoing email server, so no link was sent; set up SMTP first',
  'no-account': 'No account on this install matches that identity',
  'password-breached': 'That password appears in a list of breached passwords; choose another',
  'passkeys-unavailable': 'Passkeys need APP_URL to be https, or http://localhost',
  'passkeys-rp-changed':
    "Passkeys are paused: APP_URL's host is not the one this install's passkeys were made for",
  'second-factor-required':
    'This account must keep a second factor; add another passkey or an authenticator app first',
  'passkey-limit': 'An account can hold at most 10 passkeys; remove one first',
  'passkey-duplicate': 'This authenticator is already registered for this account',
  'totp-already-enabled':
    'An authenticator app is already on; turn it off with a live code before enrolling another',
  'passkey-invalid': 'That passkey did not verify',
};

export class AuthFailure extends HttpException {
  readonly auth: AuthErrorBody;
  readonly retryAfter: number | undefined;

  constructor(
    code: AuthErrorCode,
    options: { readonly attemptsLeft?: number; readonly retryAfter?: number } = {},
  ) {
    super(MESSAGE_BY_CODE[code], STATUS_BY_CODE[code]);
    this.name = 'AuthFailure';
    this.retryAfter = options.retryAfter;
    this.auth = {
      code,
      ...(options.attemptsLeft === undefined ? {} : { attemptsLeft: options.attemptsLeft }),
    };
  }
}

export const isAuthFailure = (error: unknown): error is AuthFailure => error instanceof AuthFailure;
