import { type DynamicModule, Module } from '@nestjs/common';
import { ApiDocsController } from './api-docs.controller.js';
import { V1ArticlesController } from './v1-articles.controller.js';
import { V1ContactsController } from './v1-contacts.controller.js';
import { V1TicketsController } from './v1-tickets.controller.js';
import { V1WebhooksController } from './v1-webhooks.controller.js';

/**
 * M8-02: the public REST API under `/api/v1`, and its OpenAPI document at
 * `/api/docs`. Nothing here owns data: every route reaches the same service
 * the admin uses, imported from the modules that own it — each already built
 * once by `AppModule`, for the reason `TicketsModule` gives.
 */
export interface ApiV1ModuleOptions {
  readonly tickets: DynamicModule;
  readonly contacts: DynamicModule;
  readonly helpCenter: DynamicModule;
  readonly webhooks: DynamicModule;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ApiV1Module {
  static forRoot({ tickets, contacts, helpCenter, webhooks }: ApiV1ModuleOptions): DynamicModule {
    return {
      module: ApiV1Module,
      imports: [tickets, contacts, helpCenter, webhooks],
      controllers: [
        ApiDocsController,
        V1TicketsController,
        V1ContactsController,
        V1ArticlesController,
        V1WebhooksController,
      ],
    };
  }
}
