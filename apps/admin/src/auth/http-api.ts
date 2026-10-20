import type {
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
import {
  authMethodsSchema,
  authSessionResponseSchema,
  enrolmentCompleteResponseSchema,
  magicLinkPreviewSchema,
  oauthConnectStartSchema,
  oauthIdentityListSchema,
  passkeyAddedSchema,
  passkeyListSchema,
  passkeyRegistrationOptionsSchema,
  passkeySchema,
  passkeyStepUpOptionsSchema,
  publicInviteSchema,
  recoveryCodesSchema,
  sessionSchema,
  signInResponseSchema,
  ssoDiscoveryResponseSchema,
  totpEnrolmentSchema,
} from '@helpdock/schemas';
import { type AuthApi, AuthError } from './api.js';
import { HttpTransport } from './http-transport.js';

/**
 * The real auth service (M0-05), plus the two flows M0-06 adds: enrolling a
 * second factor, and accepting an invitation.
 *
 * The token, the refresh and the error mapping live in {@link HttpTransport},
 * which this shares with `HttpStaffApi` — see the reasoning there.
 */
export class HttpAuthApi implements AuthApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async authMethods(): Promise<AuthMethods> {
    return authMethodsSchema.parse(await this.#transport.request('GET', '/auth/methods'));
  }

  async discoverSso(email: string) {
    return ssoDiscoveryResponseSchema.parse(
      await this.#transport.request('POST', '/auth/sso/discover', { email: email.trim() }),
    );
  }

  ssoStartUrl(connectionId: string, returnTo: string): string {
    return `${this.#transport.baseUrl}/auth/sso/${encodeURIComponent(connectionId)}/start?${new URLSearchParams({ returnTo })}`;
  }

  async signInWithPassword(email: string, password: string): Promise<SignInResult> {
    const response = signInResponseSchema.parse(
      await this.#transport.request('POST', '/auth/sign-in', { email: email.trim(), password }),
    );

    return this.#keepSession(response);
  }

  async requestMagicLink(email: string): Promise<void> {
    await this.#transport.request('POST', '/auth/magic-link', { email: email.trim() });
  }

  async previewMagicLink(token: string): Promise<MagicLinkPreview> {
    return magicLinkPreviewSchema.parse(
      await this.#transport.request('POST', '/auth/magic-link/preview', { token }),
    );
  }

  async consumeMagicLink(token: string): Promise<SignInResult> {
    const response = signInResponseSchema.parse(
      await this.#transport.request('POST', '/auth/magic-link/consume', { token }),
    );

    return this.#keepSession(response);
  }

  async verifyTotp(
    challengeId: string,
    code: string,
    { trustDevice }: { readonly trustDevice: boolean },
  ): Promise<Session> {
    const result = this.#keepSession(
      signInResponseSchema.parse(
        await this.#transport.request('POST', '/auth/totp', { challengeId, code, trustDevice }),
      ),
    );

    return this.#requireSession(result);
  }

  async useRecoveryCode(challengeId: string, code: string): Promise<Session> {
    const result = this.#keepSession(
      signInResponseSchema.parse(
        await this.#transport.request('POST', '/auth/recovery-code', { challengeId, code }),
      ),
    );

    return this.#requireSession(result);
  }

  async passkeySecondFactorOptions(challengeId: string): Promise<PasskeyStepUpOptions> {
    return passkeyStepUpOptionsSchema.parse(
      await this.#transport.request('POST', '/auth/passkey/second-factor/options', {
        challengeId,
      }),
    );
  }

  async verifyPasskey(
    challengeId: string,
    answer: PasskeySecondFactorAnswer,
    { trustDevice }: { readonly trustDevice: boolean },
  ): Promise<Session> {
    const result = this.#keepSession(
      signInResponseSchema.parse(
        await this.#transport.request('POST', '/auth/passkey/second-factor/verify', {
          challengeId,
          ceremonyId: answer.ceremonyId,
          response: answer.response,
          trustDevice,
        }),
      ),
    );

    return this.#requireSession(result);
  }

  oauthStartUrl(provider: OauthProvider): string {
    return `${this.#transport.baseUrl}/auth/oauth/${provider}/start`;
  }

  async oauthIdentities(): Promise<OauthIdentityList> {
    return oauthIdentityListSchema.parse(
      await this.#transport.request('GET', '/auth/oauth/identities'),
    );
  }

  /** The api also sets the cookie that ties the provider's callback to this browser. */
  async connectOauth(provider: OauthProvider, proof: OauthStepUpRequest): Promise<string> {
    const { url } = oauthConnectStartSchema.parse(
      await this.#transport.request('POST', `/auth/oauth/${provider}/connect`, proof),
    );
    return url;
  }

  async disconnectOauth(provider: OauthProvider, proof: OauthStepUpRequest): Promise<void> {
    await this.#transport.request('POST', `/auth/oauth/${provider}/disconnect`, proof);
  }

  async passkeys(): Promise<PasskeyList> {
    return passkeyListSchema.parse(await this.#transport.request('GET', '/me/passkeys'));
  }

  async passkeyStepUpOptions(): Promise<PasskeyStepUpOptions> {
    return passkeyStepUpOptionsSchema.parse(
      await this.#transport.request('POST', '/me/passkeys/step-up/options'),
    );
  }

  async beginPasskey(proof: PasskeyProof): Promise<PasskeyRegistrationOptions> {
    return passkeyRegistrationOptionsSchema.parse(
      await this.#transport.request('POST', '/me/passkeys/begin', { proof }),
    );
  }

  async finishPasskey(request: PasskeyFinishRequest): Promise<PasskeyAdded> {
    return passkeyAddedSchema.parse(
      await this.#transport.request('POST', '/me/passkeys/finish', request),
    );
  }

  async renamePasskey(id: string, name: string, proof: PasskeyProof): Promise<Passkey> {
    return passkeySchema.parse(
      await this.#transport.request('PATCH', `/me/passkeys/${encodeURIComponent(id)}`, {
        name,
        proof,
      }),
    );
  }

  async removePasskey(id: string, proof: PasskeyProof): Promise<void> {
    await this.#transport.request('DELETE', `/me/passkeys/${encodeURIComponent(id)}`, { proof });
  }

  async exchange(code: string): Promise<Session> {
    const response = authSessionResponseSchema.parse(
      await this.#transport.request('POST', '/auth/exchange', { code }),
    );
    this.#transport.keepSession(response);

    return response.session;
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.#transport.request('POST', '/auth/password/forgot', { email: email.trim() });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    await this.#transport.request('POST', '/auth/password/reset', { token, password });
  }

  // ------------------------------------------------------------------
  // Enrolling a second factor (M0-06)
  // ------------------------------------------------------------------

  /**
   * Stages a secret and returns what the QR code encodes. Nothing is enabled
   * until {@link confirmTotp} proves the authenticator actually holds it, so a
   * code that did not save cannot lock anybody out.
   */
  async enrolTotp(): Promise<TotpEnrolment> {
    return totpEnrolmentSchema.parse(await this.#transport.request('POST', '/auth/totp/enrol'));
  }

  async confirmTotp(code: string): Promise<RecoveryCodes> {
    return recoveryCodesSchema.parse(
      await this.#transport.request('POST', '/auth/totp/confirm', { code }),
    );
  }

  async startEnrolment(challengeId: string): Promise<TotpEnrolment> {
    return totpEnrolmentSchema.parse(
      await this.#transport.request('POST', '/auth/enrolment/start', { challengeId }),
    );
  }

  async completeEnrolment(
    challengeId: string,
    code: string,
  ): Promise<RecoveryCodes & { readonly session: Session }> {
    const response = enrolmentCompleteResponseSchema.parse(
      await this.#transport.request('POST', '/auth/enrolment/confirm', { challengeId, code }),
    );
    this.#transport.keepSession(response);

    return { recoveryCodes: response.recoveryCodes, session: response.session };
  }

  async startPasskeyEnrolment(challengeId: string): Promise<PasskeyRegistrationOptions> {
    return passkeyRegistrationOptionsSchema.parse(
      await this.#transport.request('POST', '/auth/enrolment/passkey/options', { challengeId }),
    );
  }

  async completePasskeyEnrolment(
    challengeId: string,
    request: PasskeyEnrolmentRequest,
  ): Promise<RecoveryCodes & { readonly session: Session }> {
    const response = enrolmentCompleteResponseSchema.parse(
      await this.#transport.request('POST', '/auth/enrolment/passkey/confirm', {
        challengeId,
        ...request,
      }),
    );
    this.#transport.keepSession(response);

    return { recoveryCodes: response.recoveryCodes, session: response.session };
  }

  // ------------------------------------------------------------------
  // Invitations (M0-06)
  // ------------------------------------------------------------------

  /** Reads the invitation without spending it, so a refresh costs nothing. */
  async previewInvite(token: string): Promise<PublicInvite> {
    return publicInviteSchema.parse(
      await this.#transport.request('GET', `/auth/invites/${encodeURIComponent(token)}`),
    );
  }

  async acceptInvite(token: string, request: InviteAcceptRequest): Promise<SignInResult> {
    const response = signInResponseSchema.parse(
      await this.#transport.request(
        'POST',
        `/auth/invites/${encodeURIComponent(token)}/accept`,
        request,
      ),
    );

    return this.#keepSession(response);
  }

  async startInviteOauth(
    token: string,
    provider: OauthProvider,
    request: InviteProviderStartRequest,
  ): Promise<string> {
    const { url } = oauthConnectStartSchema.parse(
      await this.#transport.request(
        'POST',
        `/auth/invites/${encodeURIComponent(token)}/oauth/${provider}`,
        request,
      ),
    );
    return url;
  }

  // ------------------------------------------------------------------

  /**
   * On a cold load there is no token yet, so this refreshes first. A browser
   * with no valid cookie gets `null`, which is what sends it to sign-in.
   */
  async me(): Promise<Session | null> {
    if (this.#transport.accessToken === null && !(await this.#transport.refresh())) {
      return null;
    }

    try {
      return sessionSchema.parse(await this.#transport.request('GET', '/auth/me'));
    } catch (error) {
      if (error instanceof AuthError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * A current access token, refreshed first when this tab holds none or holds
   * one that is about to expire.
   *
   * The one caller is the realtime client (M0-13): a browser cannot set headers
   * on a WebSocket handshake, so the token goes in `auth.token` instead of in
   * `Authorization`. It stays in memory either way.
   */
  async accessToken(): Promise<string | null> {
    return this.#transport.currentAccessToken();
  }

  async signOut(): Promise<void> {
    try {
      await this.#transport.request('POST', '/auth/sign-out');
    } finally {
      // Whatever the server said, this tab is signed out: keeping a token after
      // asking for it to be revoked would be the worst of both.
      this.#transport.accessToken = null;
    }
  }

  /** Every browser, and every browser this account trusted (DOMAIN-RULES §12). */
  async signOutEverywhere(): Promise<void> {
    try {
      await this.#transport.request('POST', '/auth/sign-out-everywhere');
    } finally {
      this.#transport.accessToken = null;
    }
  }

  // ------------------------------------------------------------------

  #keepSession(response: ReturnType<typeof signInResponseSchema.parse>): SignInResult {
    if (response.kind !== 'session') {
      return response;
    }

    this.#transport.keepSession(response);
    return { kind: 'session', session: response.session };
  }

  #requireSession(result: SignInResult): Session {
    if (result.kind !== 'session') {
      // The second factor cannot ask for a second factor, so this is the api
      // and the client disagreeing about the protocol.
      throw new AuthError('unavailable');
    }

    return result.session;
  }
}
