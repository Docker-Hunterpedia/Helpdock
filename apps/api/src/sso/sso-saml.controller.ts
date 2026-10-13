import type { Env } from '@helpdock/config';
import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import type { FormBodyRoute } from '../channels/inbound/inbound-parse-body.js';
import { ENV } from '../runtime/tokens.js';
import { SamlAcsDto, SamlCompleteQueryDto, SsoParamDto } from './dto.js';
import { oidcNonceCookie } from './oidc-contracts.js';
import { SamlService } from './saml.service.js';
import { SamlFailure } from './saml-xml.js';
import { SsoSessionCompletion } from './sso-session-completion.js';

export const SAML_ACS_ROUTE: FormBodyRoute = {
  matches: (url) => /^\/api\/auth\/sso\/[^/]+\/saml\/acs(?:\?|$)/.test(url),
  bodyLimit: 256 * 1024,
};

@Controller('api/auth/sso')
export class SsoSamlController {
  constructor(
    @Inject(SamlService) private readonly saml: SamlService,
    @Inject(SsoSessionCompletion) private readonly completion: SsoSessionCompletion,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('saml/metadata')
  @Public()
  async metadata(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    let xml: string;
    try {
      xml = await this.saml.metadata(request.ip);
    } catch (error) {
      if (error instanceof SamlFailure)
        throw new HttpException(
          'SSO metadata unavailable',
          error.code === 'sso-rate-limited' ? 429 : 404,
        );
      throw error;
    }
    reply.header('cache-control', 'no-store');
    reply.type('application/samlmetadata+xml');
    await reply.send(xml);
  }

  @Post(':id/saml/acs')
  @Public()
  async acs(
    @Param(new ZodValidationPipe(SsoParamDto)) { id }: SsoParamDto,
    @Body(new ZodValidationPipe(SamlAcsDto)) body: SamlAcsDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    try {
      const accepted = await this.saml.accept({ connectionId: id, body, ip: request.ip });
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      if (accepted.kind === 'challenge') {
        const cookie = oidcNonceCookie(this.env.APP_URL, id);
        reply.setCookie(cookie.name, accepted.browserNonce, cookie.attributes);
        await reply.redirect(accepted.url, 303);
      } else {
        const url = new URL(`/api/auth/sso/${id}/saml/complete`, this.env.APP_URL);
        url.searchParams.set('token', accepted.token);
        await reply.redirect(url.toString(), 303);
      }
    } catch (error) {
      await this.completion.refuse(reply, error);
    }
  }

  @Get(':id/saml/complete')
  @Public()
  async complete(
    @Param(new ZodValidationPipe(SsoParamDto)) { id }: SsoParamDto,
    @Query(new ZodValidationPipe(SamlCompleteQueryDto)) { token }: SamlCompleteQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const cookie = oidcNonceCookie(this.env.APP_URL, id);
    reply.clearCookie(cookie.name, cookie.attributes);
    try {
      const flow = await this.saml.complete({
        connectionId: id,
        token,
        browserNonce: request.cookies[cookie.name],
        ip: request.ip,
      });
      await this.completion.signIn(reply, flow, request.headers['user-agent']);
    } catch (error) {
      await this.completion.refuse(reply, error);
    }
  }
}
