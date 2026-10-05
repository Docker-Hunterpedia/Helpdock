import { TELEGRAM_SECRET_HEADER } from '@helpdock/schemas';
import {
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { createIpRateLimiter } from '../routes/ip-rate-limit.js';
import { TelegramWebhookParamDto } from './dto.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

/**
 * Where Telegram posts a bot's updates (M6-01). `@Public()` because Telegram
 * has no session; {@link TelegramWebhookService} checks the bot's secret
 * token. The body is the update, validated there with Zod.
 */
@Controller('api/telegram')
export class TelegramWebhookController {
  /**
   * Generous: a busy bot delivers bursts. It bounds a stranger hammering the
   * route without a secret, not Telegram doing its job.
   */
  readonly #limiter = createIpRateLimiter({
    bucket: 'telegram-webhook',
    limit: 1_200,
    windowMs: 60_000,
    maxTrackedIps: 4096,
  });
  readonly #webhooks: TelegramWebhookService;

  constructor(@Inject(TelegramWebhookService) webhooks: TelegramWebhookService) {
    this.#webhooks = webhooks;
  }

  @Post(':botId/webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param(new ZodValidationPipe(TelegramWebhookParamDto)) { botId }: TelegramWebhookParamDto,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    if (!this.#limiter.allow(request.ip)) {
      throw new HttpException('Too many Telegram requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const secret = request.headers[TELEGRAM_SECRET_HEADER];

    await this.#webhooks.receive(
      botId,
      typeof secret === 'string' ? secret : undefined,
      request.body,
    );
    return { ok: true };
  }
}
