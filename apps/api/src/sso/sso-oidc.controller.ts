import type { Env } from '@helpdock/config';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { ENV } from '../runtime/tokens.js';
import { OidcCallbackQueryDto, OidcStartQueryDto, SsoParamDto } from './dto.js';
import { OidcService } from './oidc.service.js';
import { oidcNonceCookie } from './oidc-contracts.js';
import { SamlService } from './saml.service.js';
import { SsoService } from './sso.service.js';
import { SsoSessionCompletion } from './sso-session-completion.js';

@Controller('api/auth/sso')
export class SsoOidcController {
  constructor(
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(SamlService) private readonly saml: SamlService,
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(SsoSessionCompletion) private readonly completion: SsoSessionCompletion,
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
      const starts = {
        oidc: this.oidc.start.bind(this.oidc),
        saml: this.saml.start.bind(this.saml),
      };
      const result = await starts[await this.sso.signInProtocol(id)]({
        connectionId: id,
        returnTo: query.returnTo,
        ip: request.ip,
      });
      const cookie = oidcNonceCookie(this.env.APP_URL, id);
      reply.setCookie(cookie.name, result.browserNonce, cookie.attributes);
      reply.header('cache-control', 'no-store');
      await reply.redirect(result.url, 302);
    } catch {
      await this.completion.refuse(reply, null);
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
      await this.completion.signIn(reply, result, request.headers['user-agent']);
    } catch (error) {
      await this.completion.refuse(reply, error);
    }
  }
}
