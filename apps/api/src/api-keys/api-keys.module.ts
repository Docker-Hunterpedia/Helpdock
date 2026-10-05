import { type DynamicModule, Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysRepository } from './api-keys.repository.js';
import { ApiKeysService } from './api-keys.service.js';

/**
 * M8-01: managing a brand's API keys. Resolving a key on a request is not
 * here: it happens before Nest routes anything, in the principal resolver
 * boot builds (`api-key-principal-resolver.ts`).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ApiKeysModule {
  static forRoot(): DynamicModule {
    return {
      module: ApiKeysModule,
      controllers: [ApiKeysController],
      providers: [
        { provide: ApiKeysRepository, useFactory: () => new ApiKeysRepository() },
        {
          provide: ApiKeysService,
          inject: [ApiKeysRepository],
          useFactory: (repository: ApiKeysRepository) => new ApiKeysService(repository),
        },
      ],
    };
  }
}
