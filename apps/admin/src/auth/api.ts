import type {
  AuthErrorCode,
  AuthMethods,
  InviteAcceptRequest,
  OauthProvider,
  PublicInvite,
  RecoveryCodes,
  Session,
  SignInResult,
  TotpEnrolment,
} from '@helpdock/schemas';

/**
 * Everything the auth screens need, and nothing else. `MockAuthApi` is the
 * fixture the unit tests and the mock Playwright projects run against;
 * `HttpAuthApi` is the real service (M0-05).
 *
 * No method returns an access token. The http adapter keeps one in memory and
 * attaches it to every request itself, so a screen has no token to mishandle
 * and no way to put one in `localStorage`.
 */
export interface AuthApi {
  /** Which ways in this install offers, so a disabled provider's button is not drawn. */
  authMethods(): Promise<AuthMethods>;
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
  /** Turns the one-time code a redirect carried into a session. */
  exchange(code: string): Promise<Session>;
  /** Always resolves, whether or not the address belongs to an account. */
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  /** Stages a TOTP secret. Nothing is on until a live code confirms it (M0-06). */
  enrolTotp(): Promise<TotpEnrolment>;
  /** Enables the second factor and hands over the recovery codes, once. */
  confirmTotp(code: string): Promise<RecoveryCodes>;
  /** Reads an invitation without spending it, so a refresh costs nothing. */
  previewInvite(token: string): Promise<PublicInvite>;
  /** Spends it, creates the account, and signs the person in. */
  acceptInvite(token: string, request: InviteAcceptRequest): Promise<SignInResult>;
  /** The current session, or `null` when nobody is signed in. */
  me(): Promise<Session | null>;
  signOut(): Promise<void>;
  /** Every browser, and every browser this account trusted (DOMAIN-RULES §12). */
  signOutEverywhere(): Promise<void>;
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
