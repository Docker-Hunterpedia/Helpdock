import type {
  AuthErrorCode,
  AuthMethods,
  InviteAcceptRequest,
  MagicLinkPreview,
  OauthIdentityList,
  OauthProvider,
  OauthStepUpRequest,
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
  discoverSso(email: string): Promise<{ connections: { id: string; name: string }[] }>;
  ssoStartUrl(connectionId: string, returnTo: string): string;
  signInWithPassword(email: string, password: string): Promise<SignInResult>;
  requestMagicLink(email: string): Promise<void>;
  /** Whose account a sign-in link opens. Reading it spends nothing (M9-01 F6). */
  previewMagicLink(token: string): Promise<MagicLinkPreview>;
  /** Spends the link on the person's click; answers like a password sign-in. */
  consumeMagicLink(token: string): Promise<SignInResult>;
  verifyTotp(
    challengeId: string,
    code: string,
    options: { readonly trustDevice: boolean },
  ): Promise<Session>;
  useRecoveryCode(challengeId: string, code: string): Promise<Session>;
  /** Where the browser goes to start the provider's consent flow. */
  oauthStartUrl(provider: OauthProvider): string;
  /** The provider accounts that sign in as this person, and whether they have a password. */
  oauthIdentities(): Promise<OauthIdentityList>;
  /**
   * Behind a step-up, where the browser goes to connect `provider`. The
   * provider sends it back to `/me/security?connected=<provider>`, or to the
   * callback screen with the failure.
   */
  connectOauth(provider: OauthProvider, proof: OauthStepUpRequest): Promise<string>;
  /** Behind the same step-up. Refused with `oauth-last-sign-in` for the last way in. */
  disconnectOauth(provider: OauthProvider, proof: OauthStepUpRequest): Promise<void>;
  /** Turns the one-time code a redirect carried into a session. */
  exchange(code: string): Promise<Session>;
  /** Always resolves, whether or not the address belongs to an account. */
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  /** Stages a TOTP secret. Nothing is on until a live code confirms it (M0-06). */
  enrolTotp(): Promise<TotpEnrolment>;
  /** Enables the second factor and hands over the recovery codes, once. */
  confirmTotp(code: string): Promise<RecoveryCodes>;
  /**
   * The same two steps for an account that must have a second factor and was
   * handed an enrolment challenge instead of a session. Completing it signs
   * the person in.
   */
  startEnrolment(challengeId: string): Promise<TotpEnrolment>;
  completeEnrolment(
    challengeId: string,
    code: string,
  ): Promise<RecoveryCodes & { readonly session: Session }>;
  /** Reads an invitation without spending it, so a refresh costs nothing. */
  previewInvite(token: string): Promise<PublicInvite>;
  /** Spends it, creates the account, and signs the person in. */
  acceptInvite(token: string, request: InviteAcceptRequest): Promise<SignInResult>;
  /** The current session, or `null` when nobody is signed in. */
  me(): Promise<Session | null>;
  /**
   * A current access token, refreshed first if this tab holds none, or `null`
   * when nobody is signed in.
   *
   * The one caller is the realtime client (M0-13): a browser cannot set headers
   * on a WebSocket handshake, so the token goes in `auth.token` instead of in
   * `Authorization`. It stays in memory either way — this hands the value over,
   * it does not store it anywhere new.
   */
  accessToken(): Promise<string | null>;
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
