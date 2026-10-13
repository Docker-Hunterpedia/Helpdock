import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/route-declaration.js';
import { MetaWebhookService } from './meta-webhook.service.js';
import type { MetaWebhookRequest } from './meta-webhook-body.js';

/**
 * Where Meta calls the install (M10-02), one URL for WhatsApp, Messenger and
 * Instagram. `@Public()` because Meta has no session: the handshake is
 * answered for the verify token, and every delivery is authenticated against
 * the app's signature by the route's body parser (`registerMetaWebhookBody`,
 * which also charges the address's budget) before this handler runs. The
 * parser leaves who signed on the request, and {@link MetaWebhookService}
 * refuses a request that carries nobody.
 */
@Controller('api/meta/webhook')
export class MetaWebhookController {
  readonly #webhooks: MetaWebhookService;

  constructor(@Inject(MetaWebhookService) webhooks: MetaWebhookService) {
    this.#webhooks = webhooks;
  }

  /**
   * The handshake: `hub.challenge` as plain text for the install's verify token.
   * The content type is set once the token is accepted, not by a `@Header`
   * decorator, which Nest applies before the handler runs and so would turn the
   * 403's JSON body into a payload Fastify refuses to send.
   */
  @Get()
  @Public()
  async verify(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    if (!this.#webhooks.admit(request.ip)) {
      throw new HttpException('Too many Meta requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const challenge = await this.#webhooks.verify(request.query as Record<string, unknown>);
    void reply.header('content-type', 'text/plain; charset=utf-8');
    return challenge;
  }

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: FastifyRequest & MetaWebhookRequest): Promise<{ ok: true }> {
    const { verdict } = await this.#webhooks.receive(request.body, request.metaSigner);

    if (verdict === 'failed') {
      // So Meta redelivers a batch nothing was filed from; the dedupe key makes
      // the second delivery safe.
      throw new InternalServerErrorException('The webhook could not be filed');
    }
    return { ok: true };
  }
}
