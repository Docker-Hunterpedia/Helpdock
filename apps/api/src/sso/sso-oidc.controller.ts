import type { Env } from '@helpdock/config';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { AuthFailure } from '../auth/auth-failure.js';
import { RateLimiter, SSO_DISCOVERY_RULE } from '../auth/rate-limit.js';
import { Public } from '../auth/route-declaration.js';
import { ENV, REDIS } from '../runtime/tokens.js';
import {
  OidcCallbackQueryDto,
  OidcStartQueryDto,
  SsoDiscoveryRequestDto,
  SsoDiscoveryResponseDto,
  SsoParamDto,
} from './dto.js';
import { OidcService } from './oidc.service.js';
import { oidcNonceCookie } from './oidc-contracts.js';
import { SamlService } from './saml.service.js';
import { SsoSignInPolicy } from './sign-in-policy.js';
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
    @Inject(SsoSignInPolicy) private readonly policy: SsoSignInPolicy,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Post('discover')
  @Public()
  @HttpCode(200)
  @ZodSerializerDto(SsoDiscoveryResponseDto)
  async discover(
    @Body(new ZodValidationPipe(SsoDiscoveryRequestDto)) body: SsoDiscoveryRequestDto,
    @Req() request: FastifyRequest,
  ) {
    if (!(await new RateLimiter(this.redis).consume(SSO_DISCOVERY_RULE, request.ip)))
      throw new AuthFailure('unavailable');
    return this.policy.discover(body.email);
  }

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
    } catch (error) {
      await this.completion.refuse(reply, error);
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
