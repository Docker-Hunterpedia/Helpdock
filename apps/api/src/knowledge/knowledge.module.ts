import { createKeyring, type Env, type Settings } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { SETTINGS } from '../runtime/tokens.js';
import { readOAuthApps } from './credentials.js';
import { KnowledgeController, KnowledgeOAuthController } from './knowledge.controller.js';
import type { ConnectorEndpoints } from './load-source.js';
import { safeFetchFunction } from './safe-transports.js';
import { KnowledgeSourcesService } from './sources.service.js';

export interface KnowledgeOverrides {
  /** The connectors' HTTP. The SSRF-safe client unless a suite passes a fake Notion or Google. */
  readonly fetch?: typeof fetch;
  readonly endpoints?: ConnectorEndpoints;
}

export interface KnowledgeModuleOptions {
  readonly env: Env;
  readonly storage?: ObjectStorage;
  readonly overrides?: KnowledgeOverrides;
}

/**
 * M7-03's http half: a brand's knowledge sources, uploads, sync log and
 * connector sign-in. Syncing, embedding and the article subscriber run in the
 * worker (`worker/start-worker.ts`); retrieval is called by the features that
 * answer (`retrieval/retrieve.ts`).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class KnowledgeModule {
  static forRoot({ env, storage, overrides }: KnowledgeModuleOptions): DynamicModule {
    const bucket = storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);
    return {
      module: KnowledgeModule,
      controllers: [KnowledgeController, KnowledgeOAuthController],
      providers: [
        {
          provide: KnowledgeSourcesService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): KnowledgeSourcesService =>
            new KnowledgeSourcesService({
              storage: bucket,
              keyring: createKeyring(env),
              oauthApps: () => readOAuthApps(settings),
              fetch:
                overrides?.fetch ?? safeFetchFunction({ allowCidrs: env.OUTBOUND_ALLOW_CIDRS }),
              ...(overrides?.endpoints === undefined ? {} : { endpoints: overrides.endpoints }),
              crawlRendering: env.KNOWLEDGE_CRAWL_RENDER === true,
              appUrl: env.APP_URL,
              masterKey: env.APP_MASTER_KEY,
            }),
        },
      ],
    };
  }
}
