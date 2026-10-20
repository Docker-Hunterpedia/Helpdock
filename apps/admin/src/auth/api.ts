import type {
  AuthErrorCode,
  AuthMethods,
  InviteAcceptRequest,
  InviteProviderStartRequest,
  MagicLinkPreview,
  OauthIdentityList,
  OauthProvider,
  OauthStepUpRequest,
  Passkey,
  PasskeyAdded,
  PasskeyEnrolmentRequest,
  PasskeyFinishRequest,
  PasskeyList,
  PasskeyProof,
  PasskeyRegistrationOptions,
  PasskeySecondFactorAnswer,
  PasskeyStepUpOptions,
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
  /** The options for answering a second-factor challenge with a passkey (M18-03). */
  passkeySecondFactorOptions(challengeId: string): Promise<PasskeyStepUpOptions>;
  /** Answers the challenge with what the authenticator signed; shares the attempts of a code. */
  verifyPasskey(
    challengeId: string,
    answer: PasskeySecondFactorAnswer,
    options: { readonly trustDevice: boolean },
  ): Promise<Session>;
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
  /** The caller's passkeys, for the security page's card (M18-02). */
  passkeys(): Promise<PasskeyList>;
  /** Options for answering a step-up with a passkey the account holds. */
  passkeyStepUpOptions(): Promise<PasskeyStepUpOptions>;
  /** Behind a step-up, the browser's creation options for a new passkey. */
  beginPasskey(proof: PasskeyProof): Promise<PasskeyRegistrationOptions>;
  /** Stores what the authenticator made, under the person's name for it. */
  finishPasskey(request: PasskeyFinishRequest): Promise<PasskeyAdded>;
  renamePasskey(id: string, name: string, proof: PasskeyProof): Promise<Passkey>;
  /** Refused with `second-factor-required` for the last second factor of an account that needs one. */
  removePasskey(id: string, proof: PasskeyProof): Promise<void>;
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
  /** The browser's creation options for enrolling a passkey from an enrolment challenge (M18-03). */
  startPasskeyEnrolment(challengeId: string): Promise<PasskeyRegistrationOptions>;
  /** What the authenticator made turns the factor on; answers like {@link completeEnrolment}. */
  completePasskeyEnrolment(
    challengeId: string,
    request: PasskeyEnrolmentRequest,
  ): Promise<RecoveryCodes & { readonly session: Session }>;
  /** Reads an invitation without spending it, so a refresh costs nothing. */
  previewInvite(token: string): Promise<PublicInvite>;
  /** Spends it, creates the account, and signs the person in. */
  acceptInvite(token: string, request: InviteAcceptRequest): Promise<SignInResult>;
  /**
   * Starts accepting it with a provider instead of a password (M18-07) and
   * answers where to send the browser. Spends nothing: the callback does.
   */
  startInviteOauth(
    token: string,
    provider: OauthProvider,
    request: InviteProviderStartRequest,
  ): Promise<string>;
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
  readonly retryAfter: number | undefined;

  constructor(
    code: AuthErrorCode,
    options: { readonly attemptsLeft?: number; readonly retryAfter?: number } = {},
  ) {
    super(`auth: ${code}`);
    this.name = 'AuthError';
    this.code = code;
    this.attemptsLeft = options.attemptsLeft;
    this.retryAfter = options.retryAfter;
  }
}

export const isAuthError = (error: unknown): error is AuthError => error instanceof AuthError;
