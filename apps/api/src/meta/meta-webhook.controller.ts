import { META_SIGNATURE_HEADER } from '@helpdock/schemas';
import {
  Controller,
  Get,
  GoneException,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/route-declaration.js';
import { createIpRateLimiter } from '../routes/ip-rate-limit.js';
import { MetaWebhookService } from './meta-webhook.service.js';

/**
 * Where Meta calls the install (M10-02), one URL for WhatsApp, Messenger and
 * Instagram. `@Public()` because Meta has no session: the handshake is
 * answered for the verify token and every delivery is checked against the
 * app's signature, both in {@link MetaWebhookService}. The raw body the
 * signature covers is kept by `registerMetaWebhookBody`.
 */
@Controller('api/meta/webhook')
export class MetaWebhookController {
  /**
   * Generous: one delivery is up to 1000 WhatsApp events and Meta posts bursts.
   * It bounds a stranger hammering the route without a secret, not Meta doing
   * its job.
   */
  readonly #limiter = createIpRateLimiter({
    bucket: 'meta-webhook',
    limit: 3_000,
    windowMs: 60_000,
    maxTrackedIps: 4096,
  });
  readonly #webhooks: MetaWebhookService;

  constructor(@Inject(MetaWebhookService) webhooks: MetaWebhookService) {
    this.#webhooks = webhooks;
  }

  /** The handshake: `hub.challenge` as plain text for the install's verify token. */
  @Get()
  @Public()
  @Header('content-type', 'text/plain; charset=utf-8')
  verify(@Req() request: FastifyRequest): Promise<string> {
    this.#admit(request);
    return this.#webhooks.verify(request.query as Record<string, unknown>);
  }

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: RawBodyRequest<FastifyRequest>): Promise<{ ok: true }> {
    this.#admit(request);
    const signature = request.headers[META_SIGNATURE_HEADER];
    const { verdict } = await this.#webhooks.receive(
      request.rawBody,
      typeof signature === 'string' ? signature : undefined,
      request.body,
    );

    if (verdict === 'gone') {
      throw new GoneException('This brand is no longer available');
    }
    if (verdict === 'failed') {
      // So Meta redelivers a batch nothing was filed from; the dedupe key makes
      // the second delivery safe.
      throw new InternalServerErrorException('The webhook could not be filed');
    }
    return { ok: true };
  }

  #admit(request: FastifyRequest): void {
    if (!this.#limiter.allow(request.ip)) {
      throw new HttpException('Too many Meta requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
