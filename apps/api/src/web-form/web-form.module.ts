import type { CaptchaTransport } from '@helpdock/channels';
import { createKeyring, type Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { DbCaptchaKeys, safeCaptchaTransport } from '../captcha/captcha-keys.js';
import { StorageAttachmentSink } from '../channels/inbound/attachment-sink.js';
import type { BrandResolver } from '../context/brand-resolver.js';
import type { Logger } from '../logging/logger.js';
import { MediaRepository } from '../media/media.repository.js';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { SlaLifecycleHooks } from '../sla/sla-hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import { WebFormSettingsController } from './web-form.controller.js';
import { WebFormRepository } from './web-form.repository.js';
import { WebFormPageController } from './web-form-page.controller.js';
import { WebFormPage } from './web-form-page.js';
import { WebFormPublicService } from './web-form-public.service.js';
import { WebFormSettingsService } from './web-form-settings.service.js';
import { WebFormTicketWriter } from './web-form-ticket.writer.js';

export interface WebFormModuleOptions {
  readonly env: Env;
  readonly db: Db;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly brandResolver: BrandResolver;
  /** A suite hands in a bucket double; boot builds one from `S3_*`, as `MediaModule` does. */
  readonly storage?: ObjectStorage;
  /** A suite replaces the siteverify call; boot uses the SSRF-safe client. */
  readonly captchaTransport?: CaptchaTransport;
}

/**
 * M4-09, the hosted web form: Channels › Web form's two routes, and the public
 * page at `/contact`.
 *
 * The ticket is filed by the same classes M2's inbound email uses, built from
 * plain constructors as `channels/inbound/factory.ts` builds them, so a form
 * ticket starts its SLA clocks and fires M1-12's survey hooks exactly as a
 * mailed one does.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class WebFormModule {
  static forRoot(options: WebFormModuleOptions): DynamicModule {
    const { env, db, logger } = options;
    const storage = options.storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);
    // The brand's one set of keys, edited on Channels › Widget (ADR 0003).
    const captchaKeys = new DbCaptchaKeys(db, createKeyring(env));
    const repository = new WebFormRepository();
    const lifecycleReads = new TicketLifecycleRepository();
    const tickets = new TicketRepository();
    const media = new MediaRepository();

    const forms = new WebFormPublicService({
      db,
      repository,
      writer: new WebFormTicketWriter({
        tickets,
        lifecycle: new TicketLifecycleService(
          lifecycleReads,
          tickets,
          new SlaLifecycleHooks(lifecycleReads, new SlaService(new SlaRepository())),
        ),
        assignment: new AssignmentRepository(),
      }),
      captchaKeys,
      captchaTransport: options.captchaTransport ?? safeCaptchaTransport(env.OUTBOUND_ALLOW_CIDRS),
      limiter: new RateLimiter(options.redis),
      sink: () => new StorageAttachmentSink(storage, media),
      removeObject: (key) => storage.remove(key),
      log: logger,
    });

    return {
      module: WebFormModule,
      controllers: [WebFormSettingsController, WebFormPageController],
      providers: [
        {
          provide: WebFormSettingsService,
          useValue: new WebFormSettingsService({ repository, captchaKeys, appUrl: env.APP_URL }),
        },
        {
          provide: WebFormPage,
          useValue: new WebFormPage({
            forms,
            log: logger,
            resolveHost: async (host) => {
              const found = await options.brandResolver.resolve(host);
              return found?.kind === 'helpcenter' ? found.brandId : null;
            },
          }),
        },
      ],
    };
  }
}
