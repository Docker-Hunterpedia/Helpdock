import { createKeyring, type Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { type TelegramApiFactory, telegramApiFactory } from './bot-api-factory.js';
import { createTelegramInboundService } from './factory.js';
import { OutboundTelegramService } from './outbound-telegram.service.js';
import { TelegramRepository } from './telegram.repository.js';
import {
  TelegramBotsController,
  TicketTelegramContextController,
  TicketTelegramController,
} from './telegram-bots.controller.js';
import { TelegramBotsService } from './telegram-bots.service.js';
import { TelegramDeliveriesService } from './telegram-deliveries.service.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

/** What a suite may replace: the Bot API, with a local stand-in for Telegram. */
export interface TelegramModuleOverrides {
  readonly api?: TelegramApiFactory;
}

/**
 * M6 in the api: Channels › Telegram (M6-05), the webhook (M6-01) and the
 * thread's delivery status (M6-02). Development polling and every send are
 * the worker's (`telegram-poll.job.ts`, `telegram-send.job.ts`).
 *
 * The bucket is built from the bootstrap keys as `ChannelsModule` builds it,
 * unless a suite hands one in: a webhook stores the files a message carried.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class TelegramModule {
  static forRoot(options: {
    readonly env: Env;
    readonly db: Db;
    readonly logger: Logger;
    readonly storage?: ObjectStorage;
    readonly overrides?: TelegramModuleOverrides;
  }): DynamicModule {
    const { env, db, logger } = options;
    const storage = options.storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);
    const keyring = createKeyring(env);
    const api = options.overrides?.api ?? telegramApiFactory(env.TELEGRAM_API_ROOT);
    const repository = new TelegramRepository();

    return {
      module: TelegramModule,
      controllers: [
        TelegramBotsController,
        TicketTelegramController,
        TicketTelegramContextController,
        TelegramWebhookController,
      ],
      providers: [
        {
          provide: TelegramBotsService,
          useFactory: (): TelegramBotsService =>
            new TelegramBotsService({
              repository,
              keyring,
              api,
              view: { appUrl: env.APP_URL, polling: env.TELEGRAM_POLLING === true },
            }),
        },
        {
          provide: TelegramDeliveriesService,
          useFactory: (): TelegramDeliveriesService =>
            new TelegramDeliveriesService(repository, new OutboundTelegramService(repository)),
        },
        {
          provide: TelegramWebhookService,
          useFactory: (): TelegramWebhookService =>
            new TelegramWebhookService({
              db,
              repository,
              keyring,
              inbound: createTelegramInboundService({ db, storage, log: logger, keyring, api }),
            }),
        },
      ],
    };
  }
}
