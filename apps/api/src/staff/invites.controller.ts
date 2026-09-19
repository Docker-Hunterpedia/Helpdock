import type { Env } from '@helpdock/config';
import type { PublicInvite, SignInResponse } from '@helpdock/schemas';
import { signInResponseSchema } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { SignInOutcome } from '../auth/auth.service.js';
import { Public } from '../auth/route-declaration.js';
import {
  encodeRefreshCookie,
  REFRESH_COOKIE,
  refreshCookieAttributes,
} from '../auth/session/cookies.js';
import { requireRequestContext } from '../context/request-context.js';
import { ENV } from '../runtime/tokens.js';
import { InviteAcceptRequestDto, InviteTokenParamDto, PublicInviteDto } from './dto.js';
import { InviteService } from './invite.service.js';

/**
 * The two routes a person who does not have an account yet can reach.
 *
 * They live under `/api/auth` because that is what they are: a credential — the
 * invite token — exchanged for a session. The admin app's public `/invite/:token`
 * screen reads the first and posts the second.
 *
 * **The token is in the path**, which is the one place a credential appears in
 * a URL here, for the same reason a magic link's is: a person clicks a link.
 * Both handlers replace that segment before the request line is written, so the
 * log never carries a working invitation.
 *
 * **This is the second place in the api that touches a cookie**, after
 * `AuthController`. Accepting an invitation ends in a session, and a session is
 * a refresh cookie; the attributes come from `auth/session/cookies.ts` so there
 * is still one definition of what that cookie is.
 */
@Controller('api/auth/invites')
export class InvitesController {
  readonly #invites: InviteService;
  readonly #env: Env;

  constructor(@Inject(InviteService) invites: InviteService, @Inject(ENV) env: Env) {
    this.#invites = invites;
    this.#env = env;
  }

  @Get(':token')
  @Public()
  @ZodSerializerDto(PublicInviteDto)
  preview(
    @Param(new ZodValidationPipe(InviteTokenParamDto)) { token }: InviteTokenParamDto,
    @Req() request: FastifyRequest,
  ): Promise<PublicInvite> {
    requireRequestContext().path = '/api/auth/invites/:token';

    return this.#invites.preview(token, request.ip);
  }

  @Post(':token/accept')
  @Public()
  async accept(
    @Param(new ZodValidationPipe(InviteTokenParamDto)) { token }: InviteTokenParamDto,
    @Body(new ZodValidationPipe(InviteAcceptRequestDto)) body: InviteAcceptRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SignInResponse> {
    requireRequestContext().path = '/api/auth/invites/:token/accept';

    const outcome = await this.#invites.accept(token, body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return this.#answer(outcome, reply);
  }

  /**
   * The same hand-off the sign-in routes make, and the same reason the schema
   * is applied by hand: `signInResponseSchema` is a discriminated union, which
   * `createZodDto` cannot wrap.
   */
  #answer(outcome: SignInOutcome, reply: FastifyReply): SignInResponse {
    if (outcome.kind !== 'session') {
      return signInResponseSchema.parse(outcome);
    }

    reply.setCookie(
      REFRESH_COOKIE,
      encodeRefreshCookie(outcome.issued.refreshCookieValue),
      refreshCookieAttributes(this.#env.APP_URL),
    );

    return signInResponseSchema.parse({
      kind: 'session',
      accessToken: outcome.issued.accessToken,
      expiresInSeconds: outcome.issued.expiresInSeconds,
      session: outcome.issued.session,
    });
  }
}
