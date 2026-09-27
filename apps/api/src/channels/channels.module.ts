import type { ImapConnectOptions } from '@helpdock/channels';
import { createKeyring, type Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { ImapConnectionTester, imapConnectOptions } from './imap-connector.js';
import { createInboundEmailService } from './inbound/factory.js';
import { InboundParseController } from './inbound/inbound-parse.controller.js';
import { InboundParseService } from './inbound/inbound-parse.service.js';
import { MailboxesController } from './mailboxes.controller.js';
import { MailboxesRepository } from './mailboxes.repository.js';
import { MailboxesService } from './mailboxes.service.js';
import { RemoteImagesController } from './remote-images.controller.js';
import {
  type RemoteImageFetcher,
  RemoteImagesService,
  safeImageFetcher,
} from './remote-images.service.js';

/** What a suite may replace: the IMAP connection (a self-signed test server) and the image fetcher. */
export interface ChannelsModuleOverrides {
  readonly imap?: ImapConnectOptions;
  readonly imageFetcher?: RemoteImageFetcher;
}

/**
 * M2's inbound half in the api: Channels › Mailboxes (M2-08), the
 * inbound-parse endpoints (M2-03) and the remote-image proxy (M2-07). The
 * IMAP poller is the worker's (`email-poll.job.ts`).
 *
 * The bucket is built from the bootstrap keys as `MediaModule` builds it,
 * unless a suite hands one in: an inbound-parse request stores the files a
 * message carried.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ChannelsModule {
  static forRoot(options: {
    readonly env: Env;
    readonly db: Db;
    readonly logger: Logger;
    readonly storage?: ObjectStorage;
    readonly overrides?: ChannelsModuleOverrides;
  }): DynamicModule {
    const { env, db, logger } = options;
    const storage = options.storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);
    const keyring = createKeyring(env);
    const repository = new MailboxesRepository();
    const onBlocked = (event: { host: string | undefined; address: string | undefined }): void => {
      logger.warn(
        { host: event.host, address: event.address },
        'outbound connection blocked (DOMAIN-RULES §13)',
      );
    };

    return {
      module: ChannelsModule,
      controllers: [MailboxesController, InboundParseController, RemoteImagesController],
      providers: [
        {
          provide: MailboxesService,
          useFactory: (): MailboxesService =>
            new MailboxesService({
              repository,
              keyring,
              imap: new ImapConnectionTester(
                options.overrides?.imap ??
                  imapConnectOptions({ allowCidrs: env.OUTBOUND_ALLOW_CIDRS, onBlocked }),
              ),
            }),
        },
        {
          provide: InboundParseService,
          useFactory: (): InboundParseService =>
            new InboundParseService({
              db,
              repository,
              keyring,
              inbound: createInboundEmailService({ db, storage, log: logger }),
            }),
        },
        {
          provide: RemoteImagesService,
          useFactory: (): RemoteImagesService =>
            new RemoteImagesService(
              options.overrides?.imageFetcher ??
                safeImageFetcher({ allowCidrs: env.OUTBOUND_ALLOW_CIDRS, onBlocked }),
            ),
        },
      ],
    };
  }
}
