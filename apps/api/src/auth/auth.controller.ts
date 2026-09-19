import type { Env } from '@helpdock/config';
import type {
  AuthMethods,
  AuthSessionResponse,
  OauthProvider,
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
import { AuthService, type SignInOutcome } from './auth.service.js';
import { AuthFailure, isAuthFailure } from './auth-failure.js';
import {
  AuthMethodsDto,
  AuthSessionResponseDto,
  ExchangeRequestDto,
  MagicLinkRequestDto,
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
import { Authenticated, Public } from './route-declaration.js';
import {
  decodeRefreshCookie,
  encodeRefreshCookie,
  REFRESH_COOKIE,
  refreshCookieAttributes,
  TRUSTED_DEVICE_COOKIE,
  trustedDeviceCookieAttributes,
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
 * **Every body names its schema.** The global `ZodValidationPipe` finds a DTO's
 * schema through `design:paramtypes`, which only exists when the build emits
 * decorator metadata; a transform that drops it — esbuild does — turns
 * validation off silently, and a handler here would then be handed whatever
 * JSON arrived. Naming the DTO on the parameter is the same pipe with the same
 * schema, decided at the call site instead of inferred, so these routes
 * validate wherever they run.
 */
@Controller('api/auth')
export class AuthController {
  readonly #auth: AuthService;
  readonly #sessions: SessionService;
  readonly #env: Env;

  constructor(
    @Inject(AuthService) auth: AuthService,
    @Inject(SessionService) sessions: SessionService,
    @Inject(ENV) env: Env,
  ) {
    this.#auth = auth;
    this.#sessions = sessions;
    this.#env = env;
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
      trustedDeviceCookie: request.cookies[TRUSTED_DEVICE_COOKIE],
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
      challengeId: body.challengeId,
      code: body.code,
      trustDevice: body.trustDevice,
      userAgent: request.headers['user-agent'],
    });

    if (trustedDeviceCookie !== null) {
      reply.setCookie(
        TRUSTED_DEVICE_COOKIE,
        trustedDeviceCookie,
        trustedDeviceCookieAttributes(this.#env.APP_URL),
      );
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
      challengeId: body.challengeId,
      code: body.code,
      userAgent: request.headers['user-agent'],
    });

    return this.#answer({ kind: 'session', issued }, reply);
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
   * The link itself. It answers with a redirect because a mail client is what
   * follows it, and the session is handed over as a one-time code rather than
   * as a token in the URL.
   *
   * The token *is* in this URL, which is the one place a credential appears in
   * a path. The request log would otherwise carry it, so the handler replaces
   * that segment before the line is written.
   */
  @Get('magic-link/:token')
  @Public()
  async consumeMagicLink(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    requireRequestContext().path = '/api/auth/magic-link/:token';

    const outcome = await this.#auth.consumeMagicLink(token, request.headers['user-agent']);
    if (outcome === null) {
      await this.#redirect(reply, '/sign-in/complete', { error: 'challenge-expired' });
      return;
    }

    await this.#redirectFor(outcome, reply, '/sign-in/complete');
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
  async startOauth(@Param('provider') provider: string, @Res() reply: FastifyReply): Promise<void> {
    const url = await this.#auth.startOauth(this.#provider(provider));
    await reply.redirect(url, HttpStatus.FOUND);
  }

  @Get('oauth/:provider/callback')
  @Public()
  async oauthCallback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (code === undefined || state === undefined) {
      // The provider refused, or the person declined on its consent screen.
      await this.#redirect(reply, '/oauth/callback', { error: 'unavailable', provider });
      return;
    }

    let outcome: SignInOutcome;
    try {
      outcome = await this.#auth.completeOauth({
        provider: this.#provider(provider),
        code,
        state,
        userAgent: request.headers['user-agent'],
      });
    } catch (error) {
      // A failed callback has to land on a screen, not on a JSON body: the
      // client here is a browser following a provider's redirect.
      const failure = isAuthFailure(error) ? error.auth.code : 'unavailable';
      await this.#redirect(reply, '/oauth/callback', { error: failure, provider });
      return;
    }

    await this.#redirectFor(outcome, reply, '/oauth/callback', { provider });
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
    const cookie = decodeRefreshCookie(request.cookies[REFRESH_COOKIE]);
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
    const cookie = decodeRefreshCookie(request.cookies[REFRESH_COOKIE]);
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
    reply.clearCookie(TRUSTED_DEVICE_COOKIE, trustedDeviceCookieAttributes(this.#env.APP_URL));
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
      });
      return;
    }

    if (outcome.kind === 'totp-enrolment-required') {
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
  ): Promise<void> {
    const url = new URL(path, this.#env.APP_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    await reply.redirect(url.toString(), HttpStatus.FOUND);
  }

  #setRefreshCookie(reply: FastifyReply, issued: IssuedSession): void {
    reply.setCookie(
      REFRESH_COOKIE,
      encodeRefreshCookie(issued.refreshCookieValue),
      refreshCookieAttributes(this.#env.APP_URL),
    );
  }

  #clearSessionCookies(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, refreshCookieAttributes(this.#env.APP_URL));
  }

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
