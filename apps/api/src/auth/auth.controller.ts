import type { Env } from '@helpdock/config';
import type {
  AuthMethods,
  AuthSessionResponse,
  EnrolmentCompleteResponse,
  MagicLinkPreview,
  OauthConnectStart,
  OauthIdentityList,
  OauthProvider,
  PasskeyRegistrationOptions,
  PasskeyStepUpOptions,
  RecoveryCodes,
  Session,
  SignInResponse,
  TotpEnrolment,
} from '@helpdock/schemas';
import { oauthProviderSchema, signInResponseSchema } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { ENV } from '../runtime/tokens.js';
import {
  AuthService,
  magicLinkScreenUrl,
  type OauthCallbackOutcome,
  type SignInOutcome,
} from './auth.service.js';
import { AuthFailure, isAuthFailure } from './auth-failure.js';
import {
  AuthMethodsDto,
  AuthSessionResponseDto,
  EnrolmentCompleteResponseDto,
  EnrolmentConfirmRequestDto,
  EnrolmentPasskeyConfirmRequestDto,
  EnrolmentPasskeyOptionsDto,
  EnrolmentStartRequestDto,
  ExchangeRequestDto,
  MagicLinkPreviewDto,
  MagicLinkRequestDto,
  MagicLinkTokenParamDto,
  MagicLinkTokenRequestDto,
  OauthCallbackQueryDto,
  OauthConnectStartDto,
  OauthIdentityListDto,
  OauthProviderParamDto,
  OauthStepUpRequestDto,
  PasskeyCeremonyOptionsDto,
  PasskeySecondFactorOptionsRequestDto,
  PasskeySecondFactorVerifyRequestDto,
  PasswordForgotRequestDto,
  PasswordResetRequestDto,
  RecoveryCodeRequestDto,
  RecoveryCodesDto,
  SessionDto,
  SignInRequestDto,
  TotpConfirmRequestDto,
  TotpEnrolmentDto,
  TotpRequestDto,
} from './dto.js';
import { OAUTH_STATE_TTL_SECONDS } from './oauth/oauth.service.js';
import { Authenticated, Public } from './route-declaration.js';
import { factorsParams } from './second-factor-redirect.js';
import {
  type CookieSpec,
  decodeRefreshCookie,
  encodeRefreshCookie,
  oauthNonceCookie,
  refreshCookieOf,
  trustedDeviceCookie,
} from './session/cookies.js';
import type { IssuedSession } from './session/session.service.js';
import { SessionService } from './session/session.service.js';

/**
 * Every auth route, and the only place in the api that touches a cookie.
 *
 * The routes that sign somebody in are `@Public()`: a credential is what they
 * take, so requiring a principal first would be circular. The routes that act
 * on an existing session are `@Authenticated()`, which also puts the request
 * inside its tenant transaction — so those hand `getTx()` down rather than
 * letting a service take a second connection from the pool while the first one
 * is still held.
 *
 * Two of them answer with a redirect rather than a body, because a browser
 * following a link is the client. Both build the destination from `APP_URL`
 * alone: there is no parameter anywhere in this file that can change where a
 * person is sent, which is what keeps the callbacks from being an open
 * redirect.
 *
 * **Every body, path parameter and query names its schema.** The global
 * `ZodValidationPipe` finds a DTO's schema through `design:paramtypes`, which
 * only exists when the build emits decorator metadata; a transform that drops
 * it — esbuild does — turns validation off silently, and a handler here would
 * then be handed whatever arrived. Naming the DTO on the parameter is the same
 * pipe with the same schema, decided at the call site instead of inferred, so
 * these routes validate wherever they run. `pnpm check:validation` keeps it
 * that way for the next route somebody adds.
 */
@Controller('api/auth')
export class AuthController {
  readonly #auth: AuthService;
  readonly #sessions: SessionService;
  readonly #env: Env;
  readonly #refreshCookie: CookieSpec;
  readonly #trustCookie: CookieSpec;

  constructor(
    @Inject(AuthService) auth: AuthService,
    @Inject(SessionService) sessions: SessionService,
    @Inject(ENV) env: Env,
  ) {
    this.#auth = auth;
    this.#sessions = sessions;
    this.#env = env;
    this.#refreshCookie = refreshCookieOf(env);
    this.#trustCookie = trustedDeviceCookie(env.APP_URL);
  }

  // ------------------------------------------------------------------
  // Before anyone is signed in
  // ------------------------------------------------------------------

  /** Which buttons the sign-in screen may show. A provider with no client id is off. */
  @Get('methods')
  @Public()
  @ZodSerializerDto(AuthMethodsDto)
  methods(): Promise<AuthMethods> {
    return this.#auth.methods();
  }

  @Post('sign-in')
  @Public()
  async signIn(
    @Body(new ZodValidationPipe(SignInRequestDto)) body: SignInRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignInResponse> {
    const outcome = await this.#auth.signIn({
      email: body.email,
      password: body.password,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      trustedDeviceCookie: request.cookies[this.#trustCookie.name],
    });

    return this.#answer(outcome, reply);
  }

  @Post('totp')
  @Public()
  async totp(
    @Body(new ZodValidationPipe(TotpRequestDto)) body: TotpRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignInResponse> {
    const { issued, trustedDeviceCookie } = await this.#auth.verifyTotp({
      ip: request.ip,
      challengeId: body.challengeId,
      code: body.code,
      trustDevice: body.trustDevice,
      userAgent: request.headers['user-agent'],
    });

    if (trustedDeviceCookie !== null) {
      reply.setCookie(this.#trustCookie.name, trustedDeviceCookie, this.#trustCookie.attributes);
    }

    return this.#answer({ kind: 'session', issued }, reply);
  }

  @Post('recovery-code')
  @Public()
  async recoveryCode(
    @Body(new ZodValidationPipe(RecoveryCodeRequestDto)) body: RecoveryCodeRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignInResponse> {
    const issued = await this.#auth.useRecoveryCode({
      ip: request.ip,
      challengeId: body.challengeId,
      code: body.code,
      userAgent: request.headers['user-agent'],
    });

    return this.#answer({ kind: 'session', issued }, reply);
  }

  /**
   * A passkey as the second factor (M18-03). The challenge is the credential,
   * and the same three-attempt budget and lock apply as for a code.
   */
  @Post('passkey/second-factor/options')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(PasskeyCeremonyOptionsDto)
  passkeySecondFactorOptions(
    @Body(new ZodValidationPipe(PasskeySecondFactorOptionsRequestDto))
    body: PasskeySecondFactorOptionsRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<PasskeyStepUpOptions> {
    return this.#auth.passkeySecondFactorOptions({
      challengeId: body.challengeId,
      ip: request.ip,
    });
  }

  @Post('passkey/second-factor/verify')
  @Public()
  async passkeySecondFactorVerify(
    @Body(new ZodValidationPipe(PasskeySecondFactorVerifyRequestDto))
    body: PasskeySecondFactorVerifyRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignInResponse> {
    const { issued, trustedDeviceCookie } = await this.#auth.verifyPasskeySecondFactor({
      ip: request.ip,
      challengeId: body.challengeId,
      ceremonyId: body.ceremonyId,
      response: body.response,
      trustDevice: body.trustDevice,
      userAgent: request.headers['user-agent'],
    });

    if (trustedDeviceCookie !== null) {
      reply.setCookie(this.#trustCookie.name, trustedDeviceCookie, this.#trustCookie.attributes);
    }

    return this.#answer({ kind: 'session', issued }, reply);
  }

  /**
   * Enrolment for an account that must have a second factor and was handed a
   * challenge instead of a session (`second-factor-enrolment-required`). The challenge
   * is the credential, as it is for `/totp`.
   */
  @Post('enrolment/start')
  @Public()
  @ZodSerializerDto(TotpEnrolmentDto)
  startEnrolment(
    @Body(new ZodValidationPipe(EnrolmentStartRequestDto)) body: EnrolmentStartRequestDto,
  ): Promise<TotpEnrolment> {
    return this.#auth.startEnrolment(body.challengeId);
  }

  /** The browser's creation options for enrolling a passkey instead of an app (M18-03). */
  @Post('enrolment/passkey/options')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(EnrolmentPasskeyOptionsDto)
  startPasskeyEnrolment(
    @Body(new ZodValidationPipe(EnrolmentStartRequestDto)) body: EnrolmentStartRequestDto,
  ): Promise<PasskeyRegistrationOptions> {
    return this.#auth.startPasskeyEnrolment(body.challengeId);
  }

  /** What the authenticator made turns the factor on and opens the session, like a code does. */
  @Post('enrolment/passkey/confirm')
  @Public()
  @ZodSerializerDto(EnrolmentCompleteResponseDto)
  async confirmPasskeyEnrolment(
    @Body(new ZodValidationPipe(EnrolmentPasskeyConfirmRequestDto))
    body: EnrolmentPasskeyConfirmRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EnrolmentCompleteResponse> {
    const { recoveryCodes, issued } = await this.#auth.completePasskeyEnrolment({
      ip: request.ip,
      challengeId: body.challengeId,
      ceremonyId: body.ceremonyId,
      response: body.response,
      name: body.name,
      userAgent: request.headers['user-agent'],
    });
    this.#setRefreshCookie(reply, issued);

    return {
      recoveryCodes,
      accessToken: issued.accessToken,
      expiresInSeconds: issued.expiresInSeconds,
      session: issued.session,
    };
  }

  /** A live code turns the factor on and opens the session the challenge stood in for. */
  @Post('enrolment/confirm')
  @Public()
  @ZodSerializerDto(EnrolmentCompleteResponseDto)
  async confirmEnrolment(
    @Body(new ZodValidationPipe(EnrolmentConfirmRequestDto)) body: EnrolmentConfirmRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EnrolmentCompleteResponse> {
    const { recoveryCodes, issued } = await this.#auth.completeEnrolment({
      ip: request.ip,
      challengeId: body.challengeId,
      code: body.code,
      userAgent: request.headers['user-agent'],
    });
    this.#setRefreshCookie(reply, issued);

    return {
      recoveryCodes,
      accessToken: issued.accessToken,
      expiresInSeconds: issued.expiresInSeconds,
      session: issued.session,
    };
  }

  /** 204 whatever happened, so the form cannot be used to find out who works here. */
  @Post('magic-link')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async magicLink(
    @Body(new ZodValidationPipe(MagicLinkRequestDto)) body: MagicLinkRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.#auth.requestMagicLink({ email: body.email, ip: request.ip });
  }

  /**
   * Whose account a sign-in link opens, for the confirm screen. Spends nothing.
   * The token is in the body, not the path, so it never reaches a request log.
   */
  @Post('magic-link/preview')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(MagicLinkPreviewDto)
  previewMagicLink(
    @Body(new ZodValidationPipe(MagicLinkTokenRequestDto)) { token }: MagicLinkTokenRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<MagicLinkPreview> {
    return this.#auth.previewMagicLink({ token, ip: request.ip });
  }

  /**
   * The person's click on the confirm screen: spends the link and answers like
   * `/sign-in`, a session or the second factor still to come.
   */
  @Post('magic-link/consume')
  @Public()
  async consumeMagicLink(
    @Body(new ZodValidationPipe(MagicLinkTokenRequestDto)) { token }: MagicLinkTokenRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignInResponse> {
    const outcome = await this.#auth.consumeMagicLink({
      token,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return this.#answer(outcome, reply);
  }

  /**
   * A link sent before the confirm screen existed. It spends nothing: a mail
   * scanner follows a `GET`, so a `GET` only forwards the token to the screen,
   * in the fragment, and the person's click spends it there (M9-01 F6).
   *
   * The token *is* in this URL, which is the one place a credential appears in
   * a path. The request log would otherwise carry it, so the handler replaces
   * that segment before the line is written.
   */
  @Get('magic-link/:token')
  @Public()
  async openMagicLink(
    @Param(new ZodValidationPipe(MagicLinkTokenParamDto)) { token }: MagicLinkTokenParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    requireRequestContext().path = '/api/auth/magic-link/:token';

    await reply.redirect(magicLinkScreenUrl(this.#env.APP_URL, token), HttpStatus.FOUND);
  }

  /** Turns the one-time code from a redirect into an access token. */
  @Post('exchange')
  @Public()
  @ZodSerializerDto(AuthSessionResponseDto)
  exchange(
    @Body(new ZodValidationPipe(ExchangeRequestDto)) body: ExchangeRequestDto,
  ): Promise<AuthSessionResponse> {
    return this.#auth.exchange(body.code);
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(
    @Body(new ZodValidationPipe(PasswordForgotRequestDto)) body: PasswordForgotRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.#auth.requestPasswordReset({ email: body.email, ip: request.ip });
  }

  @Post('password/reset')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Body(new ZodValidationPipe(PasswordResetRequestDto)) body: PasswordResetRequestDto,
  ): Promise<void> {
    await this.#auth.resetPassword({ token: body.token, password: body.password });
  }

  // ------------------------------------------------------------------
  // OAuth
  // ------------------------------------------------------------------

  @Get('oauth/:provider/start')
  @Public()
  async startOauth(
    @Param(new ZodValidationPipe(OauthProviderParamDto)) { provider }: OauthProviderParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const known = this.#provider(provider);
    const { url, browserNonce } = await this.#auth.startOauth(known);
    const nonceCookie = this.#oauthNonceCookie(known);
    reply.setCookie(nonceCookie.name, browserNonce, nonceCookie.attributes);
    await reply.redirect(url, HttpStatus.FOUND);
  }

  @Get('oauth/:provider/callback')
  @Public()
  async oauthCallback(
    @Param(new ZodValidationPipe(OauthProviderParamDto)) { provider }: OauthProviderParamDto,
    @Query(new ZodValidationPipe(OauthCallbackQueryDto)) { code, state }: OauthCallbackQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const known = oauthProviderSchema.safeParse(provider);
    if (!known.success) {
      await this.#redirect(reply, '/oauth/callback', { error: 'no-account', provider });
      return;
    }
    const nonceCookie = this.#oauthNonceCookie(known.data);
    const browserNonce = request.cookies[nonceCookie.name];
    // Spent whatever happens next: one round trip, one cookie.
    reply.clearCookie(nonceCookie.name, nonceCookie.attributes);
    if (code === undefined || state === undefined) {
      // The provider refused, or the person declined on its consent screen.
      await this.#redirect(reply, '/oauth/callback', { error: 'unavailable', provider });
      return;
    }

    let outcome: OauthCallbackOutcome;
    try {
      outcome = await this.#auth.completeOauth({
        provider: known.data,
        code,
        state,
        browserNonce,
        userAgent: request.headers['user-agent'],
      });
    } catch (error) {
      // A failed callback has to land on a screen, not on a JSON body: the
      // client here is a browser following a provider's redirect.
      const failure = isAuthFailure(error) ? error.auth.code : 'unavailable';
      await this.#redirect(reply, '/oauth/callback', { error: failure, provider });
      return;
    }

    if (outcome.kind === 'connected') {
      await this.#redirect(reply, '/me/security', { connected: known.data });
      return;
    }
    if (outcome.kind === 'invite-mismatch') {
      // The provider account's address goes in the fragment, which no server
      // or proxy log receives; the invite screen reads it to say which
      // account answered.
      await this.#redirect(
        reply,
        '/oauth/callback',
        { error: 'oauth-invite-mismatch', provider: known.data },
        new URLSearchParams({ account: outcome.account }).toString(),
      );
      return;
    }
    await this.#redirectFor(outcome, reply, '/oauth/callback', { provider });
  }

  /** The provider accounts that sign in as the caller (1.0.1). */
  @Get('oauth/identities')
  @Authenticated()
  @ZodSerializerDto(OauthIdentityListDto)
  oauthIdentities(): Promise<OauthIdentityList> {
    return this.#auth.oauthIdentities(this.#staffId(), getTx());
  }

  /**
   * Starts connecting a provider account to the caller, behind a step-up. It
   * answers the provider URL rather than redirecting, because the admin calls
   * it with its bearer token; the nonce cookie is set here all the same, so the
   * callback still has to come back to this browser.
   */
  @Post('oauth/:provider/connect')
  @Authenticated()
  @ZodSerializerDto(OauthConnectStartDto)
  async connectOauth(
    @Param(new ZodValidationPipe(OauthProviderParamDto)) { provider }: OauthProviderParamDto,
    @Body(new ZodValidationPipe(OauthStepUpRequestDto)) proof: OauthStepUpRequestDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OauthConnectStart> {
    const known = this.#provider(provider);
    const { url, browserNonce } = await this.#auth.startOauthConnect({
      userId: this.#staffId(),
      provider: known,
      proof,
      tx: getTx(),
    });
    const nonceCookie = this.#oauthNonceCookie(known);
    reply.setCookie(nonceCookie.name, browserNonce, nonceCookie.attributes);
    return { url };
  }

  @Post('oauth/:provider/disconnect')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnectOauth(
    @Param(new ZodValidationPipe(OauthProviderParamDto)) { provider }: OauthProviderParamDto,
    @Body(new ZodValidationPipe(OauthStepUpRequestDto)) proof: OauthStepUpRequestDto,
  ): Promise<void> {
    await this.#auth.disconnectOauth({
      userId: this.#staffId(),
      provider: this.#provider(provider),
      proof,
      tx: getTx(),
    });
  }

  // ------------------------------------------------------------------
  // With a session
  // ------------------------------------------------------------------

  @Post('refresh')
  @Public()
  @ZodSerializerDto(AuthSessionResponseDto)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSessionResponse> {
    const cookie = decodeRefreshCookie(request.cookies[this.#refreshCookie.name]);
    if (cookie === null) {
      throw new AuthFailure('challenge-expired');
    }

    const outcome = await this.#sessions.refresh({
      familyId: cookie.fam,
      token: cookie.token,
      userAgent: request.headers['user-agent'],
    });

    if (outcome.status !== 'rotated') {
      this.#clearSessionCookies(reply);
      throw new AuthFailure('challenge-expired');
    }

    this.#setRefreshCookie(reply, outcome.issued);

    return {
      accessToken: outcome.issued.accessToken,
      expiresInSeconds: outcome.issued.expiresInSeconds,
      session: outcome.issued.session,
    };
  }

  @Get('me')
  @Authenticated()
  @ZodSerializerDto(SessionDto)
  async me(): Promise<Session> {
    const session = await this.#auth.me(this.#staffId(), getTx());
    if (session === null) {
      throw new AuthFailure('no-account');
    }

    return session;
  }

  @Post('sign-out')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const cookie = decodeRefreshCookie(request.cookies[this.#refreshCookie.name]);
    if (cookie !== null) {
      await this.#sessions.revokeFamily(cookie.fam, 'sign-out');
    }

    this.#clearSessionCookies(reply);
  }

  /** DOMAIN-RULES §12: every family, and every browser this account trusted. */
  @Post('sign-out-everywhere')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOutEverywhere(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.#auth.signOutEverywhere(this.#staffId());
    this.#clearSessionCookies(reply);
    reply.clearCookie(this.#trustCookie.name, this.#trustCookie.attributes);
  }

  /** M0-06 builds the screen; the endpoints are here so the flow is complete. */
  @Post('totp/enrol')
  @Authenticated()
  @ZodSerializerDto(TotpEnrolmentDto)
  enrolTotp(): Promise<TotpEnrolment> {
    return this.#auth.enrolTotp(this.#staffId(), getTx());
  }

  @Post('totp/confirm')
  @Authenticated()
  @ZodSerializerDto(RecoveryCodesDto)
  confirmTotp(
    @Body(new ZodValidationPipe(TotpConfirmRequestDto)) body: TotpConfirmRequestDto,
  ): Promise<RecoveryCodes> {
    return this.#auth.confirmTotp(this.#staffId(), body.code, getTx());
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * The three sign-in routes share this, and it is where their output schema is
   * applied: `signInResponseSchema` is a discriminated union, which
   * `createZodDto` cannot wrap, so the parse is written out instead of
   * declared. Everything the routes answer still goes through the schema, which
   * is the property that matters (ARCHITECTURE §6, step 5).
   */
  #answer(outcome: SignInOutcome, reply: FastifyReply): SignInResponse {
    if (outcome.kind !== 'session') {
      return signInResponseSchema.parse(outcome);
    }

    this.#setRefreshCookie(reply, outcome.issued);

    return signInResponseSchema.parse({
      kind: 'session',
      accessToken: outcome.issued.accessToken,
      expiresInSeconds: outcome.issued.expiresInSeconds,
      session: outcome.issued.session,
    });
  }

  /**
   * The redirect half of the same decision: a session becomes a one-time code
   * in the query string, and a second factor becomes a challenge id the admin
   * app takes to its own code screen.
   */
  async #redirectFor(
    outcome: SignInOutcome,
    reply: FastifyReply,
    path: string,
    extra: Record<string, string> = {},
  ): Promise<void> {
    if (outcome.kind === 'totp-required') {
      await this.#redirect(reply, path, {
        ...extra,
        challenge: outcome.challengeId,
        email: outcome.email,
        ...factorsParams(outcome.factors),
      });
      return;
    }

    if (outcome.kind === 'second-factor-enrolment-required') {
      await this.#redirect(reply, path, { ...extra, enrol: outcome.challengeId });
      return;
    }

    this.#setRefreshCookie(reply, outcome.issued);
    await this.#redirect(reply, path, {
      ...extra,
      code: await this.#auth.issueExchangeCode(outcome.issued),
    });
  }

  /** Always relative to `APP_URL`, so nothing a caller sends can change the host. */
  async #redirect(
    reply: FastifyReply,
    path: string,
    params: Record<string, string>,
    fragment?: string,
  ): Promise<void> {
    const url = new URL(path, this.#env.APP_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    if (fragment !== undefined) {
      url.hash = fragment;
    }

    await reply.redirect(url.toString(), HttpStatus.FOUND);
  }

  #setRefreshCookie(reply: FastifyReply, issued: IssuedSession): void {
    reply.setCookie(
      this.#refreshCookie.name,
      encodeRefreshCookie(issued.refreshCookieValue),
      this.#refreshCookie.attributes,
    );
  }

  #oauthNonceCookie(provider: OauthProvider): CookieSpec {
    return oauthNonceCookie(this.#env.APP_URL, OAUTH_STATE_TTL_SECONDS, provider);
  }

  #clearSessionCookies(reply: FastifyReply): void {
    reply.clearCookie(this.#refreshCookie.name, this.#refreshCookie.attributes);
  }

  /**
   * Which providers exist, applied here rather than by the parameter's pipe:
   * both OAuth routes answer a browser with a redirect, and a pipe can only
   * answer with a body. `oauthProviderParamSchema` bounds the segment; this
   * turns an unknown one into a refusal the sign-in screen can render.
   */
  #provider(value: string): OauthProvider {
    const parsed = oauthProviderSchema.safeParse(value);
    if (!parsed.success) {
      throw new AuthFailure('no-account');
    }

    return parsed.data;
  }

  /** The guard has already refused anything but a staff principal with a session. */
  #staffId(): string {
    const principal = requireRequestContext().principal;
    /* c8 ignore next 3 -- `@Authenticated()` refuses the request before this runs. */
    if (principal === null || principal.type !== 'staff') {
      throw new AuthFailure('unavailable');
    }

    return principal.id;
  }
}
