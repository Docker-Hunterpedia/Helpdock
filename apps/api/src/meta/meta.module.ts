import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { SETTINGS } from '../runtime/tokens.js';
import { type GraphClientFactory, graphClientFactory } from './graph-client-factory.js';
import { MetaRepository } from './meta.repository.js';
import { MetaAccountsController } from './meta-accounts.controller.js';
import { MetaAccountsService } from './meta-accounts.service.js';
import { MetaAppController } from './meta-app.controller.js';
import { MetaAppService } from './meta-app.service.js';
import {
  type MetaInboundHandlers,
  MetaInboundService,
  unhandledInboundHandlers,
} from './meta-inbound.service.js';
import { MetaWebhookController } from './meta-webhook.controller.js';
import { MetaWebhookService } from './meta-webhook.service.js';

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
 * {@link MetaInboundHandlers} of its platform. Until M10-03, -04 and -05 land
 * theirs, the default for a platform logs and counts what arrived
 * (`unhandledInbound`), so the route is complete and testable without them.
 * Each of those deliverables replaces its platform's entry in `handlers` below.
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
    const graph = overrides?.graph ?? graphClientFactory(env);
    const handlers: MetaInboundHandlers = {
      ...unhandledInboundHandlers(logger),
      ...overrides?.inbound,
    };

    return {
      module: MetaModule,
      controllers: [MetaWebhookController, MetaAppController, MetaAccountsController],
      providers: [
        { provide: MetaRepository, useValue: repository },
        { provide: META_GRAPH, useValue: graph },
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
              inbound: new MetaInboundService({ db, repository, handlers, log: logger }),
            }),
        },
      ],
    };
  }
}
