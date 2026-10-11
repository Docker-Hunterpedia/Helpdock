import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { SETTINGS } from '../runtime/tokens.js';
import { createMetaInboundService } from './factory.js';
import { type GraphClientFactory, graphClientFactory } from './graph-client-factory.js';
import { MetaRepository } from './meta.repository.js';
import { MetaAppController } from './meta-app.controller.js';
import { MetaAppService } from './meta-app.service.js';
import { MetaDeliveriesService } from './meta-deliveries.service.js';
import {
  type MetaInboundHandlers,
  MetaInboundService,
  unhandledInboundHandlers,
} from './meta-inbound.service.js';
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
  readonly graph?: GraphClientFactory;
  readonly inbound?: Partial<MetaInboundHandlers>;
}

/** The Graph client the Meta services share, for the providers of M10-04, -05, -07 and -10. */
export const META_GRAPH = Symbol('helpdock.meta.graph');

/**
 * M10 in the api: the App card (M10-02), the webhook (M10-02) and, as the
 * deliverables land, the accounts' routes (M10-07) and the ticket's delivery
 * status (M10-06). The sends, the media fetches and the health checks are the
 * worker's.
 *
 * **The inbound services.** The webhook hands each account's events to the
 * {@link MetaInboundHandlers} of its platform. WhatsApp's (M10-03) and
 * Messenger's (M10-04) and Instagram's (M10-05) are installed beside WhatsApp's;
 * the default for a platform logs and counts what arrived (`unhandledInbound`),
 * so the route stays complete and testable. Each deliverable replaces its
 * platform's entry in `handlersFor` below.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class MetaModule {
  static forRoot(options: {
    readonly env: Env;
    readonly db: Db;
    readonly logger: Logger;
    /** The bucket the media fetch writes to; built from the bootstrap keys unless a suite hands one in. */
    readonly storage?: ObjectStorage;
    readonly overrides?: MetaModuleOverrides;
  }): DynamicModule {
    const { env, db, logger, overrides } = options;
    const repository = new MetaRepository();
    const storage = options.storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);
    const graph = overrides?.graph ?? graphClientFactory(env);
    // The inbound services read the install's settings (the app id, to recognise
    // Helpdock's own echoes), which Nest hands over once it has built them.
    const handlersFor = (settings: Settings): MetaInboundHandlers => {
      const inbound = createMetaInboundService({
        db,
        storage,
        log: logger,
        keyring: createKeyring(env),
        graph,
        appId: () => settings.get('meta.appId'),
      });

      return {
        ...unhandledInboundHandlers(logger),
        whatsapp: inbound.whatsapp,
        messenger: inbound.messenger,
        instagram: inbound.instagram,
        ...overrides?.inbound,
      };
    };

    return {
      module: MetaModule,
      controllers: [
        MetaWebhookController,
        MetaAppController,
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
        { provide: META_GRAPH, useValue: graph },
        {
          provide: MetaAppService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): MetaAppService => new MetaAppService(settings, env),
        },
        {
          provide: MetaWebhookService,
          inject: [MetaAppService, SETTINGS],
          useFactory: (app: MetaAppService, settings: Settings): MetaWebhookService =>
            new MetaWebhookService({
              db,
              repository,
              app,
              log: logger,
              inbound: new MetaInboundService({
                db,
                repository,
                handlers: handlersFor(settings),
                log: logger,
              }),
            }),
        },
      ],
    };
  }
}
