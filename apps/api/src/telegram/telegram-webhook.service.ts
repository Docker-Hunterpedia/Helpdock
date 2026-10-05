import { createHash, timingSafeEqual } from 'node:crypto';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ZodError } from 'zod';
import { withSystemJob } from '../tenant/system-job.js';
import type { TelegramRepository } from './telegram.repository.js';
import type { TelegramInboundResult, TelegramInboundService } from './telegram-inbound.service.js';

/**
 * `POST /api/telegram/:botId/webhook` (M6-01). The request carries no session;
 * the credential is the `X-Telegram-Bot-Api-Secret-Token` header, which
 * Telegram echoes from the secret "Set webhook" registered.
 *
 * 1. Find the bot the path names, across every brand (an install-scope read
 *    of one table).
 * 2. Compare the header with that bot's secret in constant time. An unknown
 *    bot and a wrong secret are the same 401, so the route does not confirm
 *    which bot ids exist.
 * 3. Hand the update to {@link TelegramInboundService}. A body that is not an
 *    update at all is a 400; anything filed, dropped or seen before is a 200,
 *    because Telegram's retry would only meet the same answer.
 */
export class TelegramWebhookService {
  readonly #db: Db;
  readonly #repository: TelegramRepository;
  readonly #inbound: TelegramInboundService;
  readonly #keyring: Keyring;

  constructor(options: {
    readonly db: Db;
    readonly repository: TelegramRepository;
    readonly inbound: TelegramInboundService;
    readonly keyring: Keyring;
  }) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#inbound = options.inbound;
    this.#keyring = options.keyring;
  }

  async receive(
    botId: string,
    presented: string | undefined,
    body: unknown,
  ): Promise<TelegramInboundResult> {
    const locator = await this.#repository.locate(this.#db, botId);
    if (locator === undefined || presented === undefined || presented === '') {
      throw refused();
    }
    const bot = await withSystemJob(this.#db, locator.brandId, 'telegram.webhook', (tx) =>
      this.#repository.bot(tx, botId),
    );
    if (
      bot === undefined ||
      !sameSecret(decryptSecret(bot.webhookSecret, this.#keyring), presented)
    ) {
      throw refused();
    }

    try {
      return await this.#inbound.receive(locator, body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException('The body is not a Telegram update');
      }
      throw error;
    }
  }
}

/** Digests first, so the comparison takes the same time whatever the lengths. */
export const sameSecret = (stored: string, presented: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(stored).digest(),
    createHash('sha256').update(presented).digest(),
  );

const refused = (): UnauthorizedException =>
  new UnauthorizedException('The Telegram secret token is missing or wrong for this bot');
