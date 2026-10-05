import type { HttpTransport } from '@helpdock/ai';
import type { Env, Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { safeAiTransport } from '../ai/ai-http.js';
import { createAiRuntime } from '../ai/db-ai-ports.js';
import { RefreshStore } from '../auth/session/refresh-store.js';
import type { SigningKeys } from '../auth/session/signing-keys.js';
import type { BrandResolver } from '../context/brand-resolver.js';
import { createQueryEmbedder } from '../knowledge/retrieval/retrieve.js';
import type { Logger } from '../logging/logger.js';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { DB, HOST_PAGES, SETTINGS } from '../runtime/tokens.js';
import { HelpCenterArticlesService } from './articles.service.js';
import { HelpCenterContentService } from './content.service.js';
import { HelpCenterFeedbackService } from './feedback/feedback.service.js';
import { HelpCenterInsightsController } from './feedback/insights.controller.js';
import { HelpCenterInsightsService } from './feedback/insights.service.js';
import { HelpCenterController } from './help-center.controller.js';
import { HelpCenterRepository } from './help-center.repository.js';
import { HelpCenterMediaController } from './help-center-media.controller.js';
import { HelpCenterMediaService } from './media.service.js';
import {
  HELP_CENTER_FEEDBACK,
  HELP_CENTER_SEARCH,
  type HelpCenterFeedback,
  type HelpCenterSearch,
} from './ports.js';
import { HelpCenterSearchService } from './search/search.service.js';
import { HelpCenterSettingsService } from './settings.service.js';
import { type PageCache, RedisPageCache } from './site/page-cache.js';
import { HelpCenterHostPages, HelpCenterSiteController } from './site/site.controller.js';
import { HelpCenterSite } from './site/site.js';
import { DbSiteContent, imageSourcesOf } from './site/site-content.js';
import {
  HC_SIGNING_KEYS,
  HelpCenterSiteSettingsController,
} from './site/site-settings.controller.js';
import { HelpCenterSiteSettingsService } from './site/site-settings.service.js';
import { StaffAccess } from './site/staff-access.js';
import { HelpCenterStaffPassService } from './site/staff-pass.service.js';
import { HelpCenterStructureService } from './structure.service.js';

export interface HelpCenterModuleOptions {
  readonly env: Env;
  readonly redis: Redis;
  readonly logger: Logger;
  /** The session key: the staff cookie is signed with it, and a staff pass reads the caller's family with it. */
  readonly signingKeys: SigningKeys;
  /** `Host` → brand, for the pages on a brand's own domain (M5-07). */
  readonly hosts: BrandResolver;
  /** A bucket double for the suites; boot leaves it out and an S3 client is built. */
  readonly storage?: ObjectStorage;
  /** M7-04: the embeddings HTTP behind semantic search. The SSRF-safe client unless a suite passes a fake. */
  readonly aiHttp?: HttpTransport;
  /** A suite may pass its own; boot uses Redis. */
  readonly pageCache?: PageCache;
}

/**
 * The help center: M5-01, M5-02 and M5-09's Articles tab, editor, "Who can
 * read it" and article images, and `HelpCenterContentService`, which the
 * pages, the sitemap and search (M5-03 to M5-05) and the widget (M5-10) read
 * the published help center through; M5-03, M5-04 and M5-06's pages, SEO and
 * site settings; M5-05 and M5-08's search, views, feedback and the Insights
 * tab.
 *
 * The pages depend on search and feedback only through the two ports of
 * `ports.ts`, bound here to `HelpCenterSearchService` and
 * `HelpCenterFeedbackService` and exported for the widget (M5-10).
 *
 * The scheduled publish, the image conversion, the search index's subscriber
 * and the page cache's invalidation run in the worker, wired in
 * `worker/start-worker.ts` from the same building blocks, as `MediaModule`
 * explains for `media.process`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class HelpCenterModule {
  static forRoot(options: HelpCenterModuleOptions): DynamicModule {
    const { env, redis, logger } = options;
    const repository = new HelpCenterRepository();
    const storage = options.storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);
    const staffAccess = new StaffAccess({
      redis,
      keys: options.signingKeys,
      families: new RefreshStore(redis),
    });
    const siteSettings = new HelpCenterSiteSettingsService({ appUrl: env.APP_URL });

    return {
      module: HelpCenterModule,
      controllers: [
        HelpCenterController,
        HelpCenterMediaController,
        HelpCenterInsightsController,
        HelpCenterSiteSettingsController,
        HelpCenterSiteController,
      ],
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
        // M5-05, M5-08: the ports the help center pages and the widget read through.
        {
          provide: HELP_CENTER_SEARCH,
          inject: [DB, SETTINGS],
          useFactory: (db: Db, settings: Settings) =>
            new HelpCenterSearchService(db, {
              embedQuery: createQueryEmbedder(
                db,
                createAiRuntime({
                  db,
                  settings,
                  http: options.aiHttp ?? safeAiTransport(env.OUTBOUND_ALLOW_CIDRS),
                }),
                (error) => logger.warn({ err: error }, 'semantic search fell back to full text'),
              ),
            }),
        },
        {
          provide: HELP_CENTER_FEEDBACK,
          inject: [DB],
          useFactory: (db: Db) => new HelpCenterFeedbackService(db),
        },
        HelpCenterInsightsService,
        { provide: HelpCenterSiteSettingsService, useValue: siteSettings },
        {
          provide: HelpCenterStaffPassService,
          useValue: new HelpCenterStaffPassService({ access: staffAccess, settings: siteSettings }),
        },
        { provide: HC_SIGNING_KEYS, useValue: options.signingKeys },
        {
          provide: HelpCenterSite,
          inject: [DB, HelpCenterContentService, HELP_CENTER_SEARCH, HELP_CENTER_FEEDBACK],
          useFactory: (
            db: Db,
            content: HelpCenterContentService,
            search: HelpCenterSearch,
            feedback: HelpCenterFeedback,
          ) =>
            new HelpCenterSite({
              content: new DbSiteContent(db, content),
              hosts: {
                brandOf: async (host) => {
                  const found = await options.hosts.resolve(host);
                  return found?.kind === 'helpcenter' ? found.brandId : null;
                },
              },
              search,
              feedback,
              cache: options.pageCache ?? new RedisPageCache(redis),
              staff: staffAccess,
              appUrl: env.APP_URL,
              imageSources: imageSourcesOf(env),
              visitorSecret: `hd-help-center-visitor:${env.APP_MASTER_KEY}`,
              log: logger,
            }),
        },
        {
          provide: HOST_PAGES,
          inject: [HelpCenterSite],
          useFactory: (site: HelpCenterSite) => new HelpCenterHostPages(site),
        },
      ],
      exports: [HelpCenterContentService, HELP_CENTER_SEARCH, HELP_CENTER_FEEDBACK, HOST_PAGES],
    };
  }
}
