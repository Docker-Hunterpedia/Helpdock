import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { DB } from '../runtime/tokens.js';
import { HelpCenterArticlesService } from './articles.service.js';
import { HelpCenterContentService } from './content.service.js';
import { HelpCenterController } from './help-center.controller.js';
import { HelpCenterRepository } from './help-center.repository.js';
import { HelpCenterMediaController } from './help-center-media.controller.js';
import { HelpCenterMediaService } from './media.service.js';
import { HelpCenterSettingsService } from './settings.service.js';
import { HelpCenterStructureService } from './structure.service.js';

export interface HelpCenterModuleOptions {
  readonly env: Env;
  /** A bucket double for the suites; boot leaves it out and an S3 client is built. */
  readonly storage?: ObjectStorage;
}

/**
 * M5-01, M5-02, M5-09: the Articles tab and the editor, "Who can read it",
 * article images, and `HelpCenterContentService` — exported, because it is
 * what the help center pages, the sitemap and search (M5-03 to M5-05) and the
 * widget (M5-10) read the published help center through.
 *
 * The scheduled publish and the image conversion run in the worker, wired in
 * `worker/start-worker.ts` from the same building blocks, as `MediaModule`
 * explains for `media.process`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class HelpCenterModule {
  static forRoot(options: HelpCenterModuleOptions): DynamicModule {
    const repository = new HelpCenterRepository();
    const storage =
      options.storage ?? new S3ObjectStorage(createS3Client(options.env), options.env.S3_BUCKET);

    return {
      module: HelpCenterModule,
      controllers: [HelpCenterController, HelpCenterMediaController],
      providers: [
        {
          provide: HelpCenterStructureService,
          useFactory: () => new HelpCenterStructureService(repository),
        },
        {
          provide: HelpCenterArticlesService,
          useFactory: () => new HelpCenterArticlesService(repository),
        },
        {
          provide: HelpCenterSettingsService,
          useFactory: () => new HelpCenterSettingsService(repository),
        },
        { provide: HelpCenterMediaService, useFactory: () => new HelpCenterMediaService(storage) },
        {
          provide: HelpCenterContentService,
          inject: [DB],
          useFactory: (db: Db) => new HelpCenterContentService(db),
        },
      ],
      exports: [HelpCenterContentService],
    };
  }
}
