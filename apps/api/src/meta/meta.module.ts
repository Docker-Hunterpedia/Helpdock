import type { GraphClient } from '@helpdock/channels';
import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { SETTINGS } from '../runtime/tokens.js';
import { createMetaInboundHandlers } from './factory.js';
import { createGraphClient } from './graph-client-factory.js';
import { MetaRepository } from './meta.repository.js';
import { MetaAccountsController } from './meta-accounts.controller.js';
import { MetaAccountsService } from './meta-accounts.service.js';
import { MetaAppController } from './meta-app.controller.js';
import { MetaAppService } from './meta-app.service.js';
import { MetaDeliveriesService } from './meta-deliveries.service.js';
import { type MetaInboundHandlers, MetaInboundService } from './meta-inbound.service.js';
import { MetaWebhookController } from './meta-webhook.controller.js';
import { MetaWebhookService } from './meta-webhook.service.js';
import { OutboundMetaService } from './outbound-meta.service.js';
import {
  TicketMetaContextController,
  TicketMetaDeliveriesController,
} from './ticket-meta.controller.js';

/**
 * What a suite may replace: the Graph client, with the local stand-in for Meta,
 * and the inbound service of a platform, with a double that records what the
 * webhook hands it.
 */
export interface MetaModuleOverrides {
  readonly graph?: GraphClient;
  readonly inbound?: Partial<MetaInboundHandlers>;
}

/**
 * M10 in the api: the App card and the webhook (M10-02) with the inbound
 * services behind it (M10-03 to M10-05), the accounts' routes (M10-07) and the
 * ticket view's half of replies, the window, the deliveries and Retry (M10-06).
 * The sends, the media and profile fetches and the health checks are the
 * worker's.
 *
 * **The inbound services.** The webhook hands each account's events to the
 * {@link MetaInboundHandlers} of its platform, which `createMetaInboundHandlers`
 * builds on the install's app id; a suite replaces any of them through
 * `overrides.inbound`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class MetaModule {
  static forRoot(options: {
    readonly env: Env;
    readonly db: Db;
    readonly logger: Logger;
    readonly overrides?: MetaModuleOverrides;
  }): DynamicModule {
    const { env, db, logger, overrides } = options;
    const repository = new MetaRepository();
    const graph = overrides?.graph ?? createGraphClient(env, logger);

    return {
      module: MetaModule,
      controllers: [
        MetaWebhookController,
        MetaAppController,
        MetaAccountsController,
        TicketMetaDeliveriesController,
        TicketMetaContextController,
      ],
      providers: [
        { provide: MetaRepository, useValue: repository },
        // M10-06. The ticket view's half: the window, the deliveries, Retry.
        {
          provide: MetaDeliveriesService,
          useFactory: (): MetaDeliveriesService =>
            new MetaDeliveriesService(repository, new OutboundMetaService(repository)),
        },
        {
          provide: MetaAppService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): MetaAppService => new MetaAppService(settings, env),
        },
        {
          provide: MetaAccountsService,
          inject: [MetaAppService],
          useFactory: (appService: MetaAppService): MetaAccountsService =>
            new MetaAccountsService({
              db,
              repository,
              keyring: createKeyring(env),
              graph,
              app: appService,
              log: logger,
            }),
        },
        {
          provide: MetaWebhookService,
          inject: [MetaAppService],
          useFactory: (app: MetaAppService): MetaWebhookService =>
            new MetaWebhookService({
              db,
              repository,
              app,
              log: logger,
              inbound: new MetaInboundService({
                db,
                repository,
                handlers: {
                  ...createMetaInboundHandlers({ log: logger, appId: () => app.appId() }),
                  ...overrides?.inbound,
                },
                log: logger,
              }),
            }),
        },
      ],
    };
  }
}
