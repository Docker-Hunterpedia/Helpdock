import type { Env } from '@helpdock/config';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { AuthService } from '../auth/auth.service.js';
import { isAuthFailure } from '../auth/auth-failure.js';
import { Public } from '../auth/route-declaration.js';
import { encodeRefreshCookie, refreshCookieOf } from '../auth/session/cookies.js';
import { ENV } from '../runtime/tokens.js';
import { OidcCallbackQueryDto, OidcStartQueryDto, SsoParamDto } from './dto.js';
import { OidcService } from './oidc.service.js';
import { oidcNonceCookie } from './oidc-contracts.js';

@Controller('api/auth/sso')
export class SsoOidcController {
  constructor(
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get(':id/start')
  @Public()
  async start(
    @Param(new ZodValidationPipe(SsoParamDto)) { id }: SsoParamDto,
    @Query(new ZodValidationPipe(OidcStartQueryDto)) query: OidcStartQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.oidc.start({
        connectionId: id,
        returnTo: query.returnTo,
        ip: request.ip,
      });
      const cookie = oidcNonceCookie(this.env.APP_URL, id);
      reply.setCookie(cookie.name, result.browserNonce, cookie.attributes);
      reply.header('cache-control', 'no-store');
      await reply.redirect(result.url, 302);
    } catch {
      await this.redirect(reply, { error: 'unavailable' });
    }
  }

  @Get(':id/oidc/callback')
  @Public()
  async callback(
    @Param(new ZodValidationPipe(SsoParamDto)) { id }: SsoParamDto,
    @Query(new ZodValidationPipe(OidcCallbackQueryDto)) query: OidcCallbackQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const cookie = oidcNonceCookie(this.env.APP_URL, id);
    reply.clearCookie(cookie.name, cookie.attributes);
    try {
      const result = await this.oidc.complete({
        connectionId: id,
        query,
        browserNonce: request.cookies[cookie.name],
        ip: request.ip,
      });
      const outcome = await this.auth.completeSso(result.assertion, request.headers['user-agent']);
      if (outcome.kind === 'totp-required') {
        await this.redirect(reply, {
          challenge: outcome.challengeId,
          email: outcome.email,
          returnTo: result.returnTo,
        });
      } else if (outcome.kind === 'totp-enrolment-required') {
        await this.redirect(reply, { enrol: outcome.challengeId, returnTo: result.returnTo });
      } else {
        const refresh = refreshCookieOf(this.env);
        reply.setCookie(
          refresh.name,
          encodeRefreshCookie(outcome.issued.refreshCookieValue),
          refresh.attributes,
        );
        await this.redirect(reply, {
          code: await this.auth.issueExchangeCode(outcome.issued),
          returnTo: result.returnTo,
        });
      }
    } catch (error) {
      await this.redirect(reply, { error: isAuthFailure(error) ? error.auth.code : 'unavailable' });
    }
  }

  private async redirect(reply: FastifyReply, params: Record<string, string>) {
    const url = new URL('/sign-in/complete', this.env.APP_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    await reply.redirect(url.toString(), 302);
  }
}
