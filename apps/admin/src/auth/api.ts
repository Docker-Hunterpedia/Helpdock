import type { AuthErrorCode, OauthProvider, Session, SignInResult } from './schemas.js';

/**
 * Everything the auth screens need, and nothing else. `MockAuthApi` implements
 * it today; M0-05 (#8) implements `HttpAuthApi` against the real endpoints and
 * no screen changes.
 */
export interface AuthApi {
  signInWithPassword(email: string, password: string): Promise<SignInResult>;
  requestMagicLink(email: string): Promise<void>;
  verifyTotp(
    challengeId: string,
    code: string,
    options: { readonly trustDevice: boolean },
  ): Promise<Session>;
  useRecoveryCode(challengeId: string, code: string): Promise<Session>;
  /** Where the browser goes to start the provider's consent flow. */
  oauthStartUrl(provider: OauthProvider): string;
  /** The current session, or `null` when nobody is signed in. */
  me(): Promise<Session | null>;
  signOut(): Promise<void>;
}

/**
 * A failure the screens can react to. The `code` picks the catalog key, so the
 * message a user reads is always a translated string and never an api string.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly attemptsLeft: number | undefined;

  constructor(code: AuthErrorCode, options: { readonly attemptsLeft?: number } = {}) {
    super(`auth: ${code}`);
    this.name = 'AuthError';
    this.code = code;
    this.attemptsLeft = options.attemptsLeft;
  }
}

export const isAuthError = (error: unknown): error is AuthError => error instanceof AuthError;
