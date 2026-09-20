import type { Env } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { MediaController } from './media.controller.js';
import { MediaRepository } from './media.repository.js';
import { MediaService } from './media.service.js';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from './storage.js';
import { OBJECT_STORAGE } from './tokens.js';

/**
 * M1-10's api half: presign, confirm, download, delete.
 *
 * The worker half is not here. `APP_ROLE=worker` runs no Nest application
 * (`worker/start-worker.ts`), so `media.process` is wired there from the same
 * building blocks — `createMediaProcessor`, `createS3Client` — rather than
 * through dependency injection. That is the shape M0 already settled for the
 * outbox consumer, not a second one.
 *
 * `ObjectStorage` is provided by a token rather than by its class so a test can
 * hand the service a double without a bucket, which is what every unit suite in
 * `media.service.test.ts` does.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class MediaModule {
  static forRoot(options: { env: Env; storage?: ObjectStorage }): DynamicModule {
    const storage =
      options.storage ?? new S3ObjectStorage(createS3Client(options.env), options.env.S3_BUCKET);

    return {
      module: MediaModule,
      controllers: [MediaController],
      // Nothing is exported. The message-create path reaches the pipeline
      // through `linkAttachmentsToMessage` and a `MediaRepository` of its own
      // (`tickets.module.ts` says why), so this module is only ever imported
      // for its controller.
      providers: [MediaRepository, MediaService, { provide: OBJECT_STORAGE, useValue: storage }],
    };
  }
}
