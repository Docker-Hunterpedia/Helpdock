import { createKeyring, type Env } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksRepository } from './webhooks.repository.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * M8-03: managing a brand's webhook endpoints and reading their delivery log.
 * Delivering runs in the worker (`webhook-events.ts`, `webhook-deliver.job.ts`).
 * The service is exported for the public API's `webhooks:manage` routes.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class WebhooksModule {
  static forRoot({ env }: { readonly env: Env }): DynamicModule {
    const keyring = createKeyring(env);

    return {
      module: WebhooksModule,
      controllers: [WebhooksController],
      providers: [
        { provide: WebhooksRepository, useFactory: () => new WebhooksRepository() },
        {
          provide: WebhooksService,
          inject: [WebhooksRepository],
          useFactory: (repository: WebhooksRepository) => new WebhooksService(repository, keyring),
        },
      ],
      exports: [WebhooksService],
    };
  }
}
