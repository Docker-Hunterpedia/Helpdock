import { type DynamicModule, Module } from '@nestjs/common';
import { RetentionController } from './retention.controller.js';
import { RetentionRepository } from './retention.repository.js';
import { RetentionService } from './retention.service.js';

/**
 * M1-14's http half: the Data retention form. The nightly purge is the
 * worker's (`retention.job.ts`), and contact erasure stays in `contacts/`,
 * which reaches the ticket tables through `ContactErasureProvider`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class RetentionModule {
  static forRoot(): DynamicModule {
    return {
      module: RetentionModule,
      controllers: [RetentionController],
      providers: [
        {
          provide: RetentionRepository,
          useFactory: (): RetentionRepository => new RetentionRepository(),
        },
        {
          provide: RetentionService,
          inject: [RetentionRepository],
          useFactory: (repository: RetentionRepository): RetentionService =>
            new RetentionService(repository),
        },
      ],
    };
  }
}
