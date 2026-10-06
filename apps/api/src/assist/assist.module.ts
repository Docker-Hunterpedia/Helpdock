import type { HttpTransport, ModelTransport } from '@helpdock/ai';
import type { Env, Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import { AiRepository } from '../ai/ai.repository.js';
import { safeAiTransport } from '../ai/ai-http.js';
import { BudgetMeter } from '../ai/budget-meter.js';
import { createAiRuntime } from '../ai/db-ai-ports.js';
import { HelpCenterArticlesService } from '../help-center/articles.service.js';
import { HelpCenterRepository } from '../help-center/help-center.repository.js';
import { createQueryEmbedder, createRetriever } from '../knowledge/retrieval/retrieve.js';
import { DB, SETTINGS } from '../runtime/tokens.js';
import { AssistController } from './assist.controller.js';
import { AssistRepository } from './assist.repository.js';
import { AssistService } from './assist.service.js';
import { AssistStateService } from './assist-state.service.js';
import { ProposalsController } from './proposals.controller.js';
import { ProposalsRepository } from './proposals.repository.js';
import { ProposalsService } from './proposals.service.js';

export interface AssistModuleOptions {
  readonly env: Pick<Env, 'OUTBOUND_ALLOW_CIDRS'>;
  /** Embeddings for retrieval. The SSRF-safe client unless a suite passes a fake. */
  readonly http?: HttpTransport;
  /** pi-ai unless a suite passes the faux provider's transport. */
  readonly transport?: ModelTransport;
}

/**
 * M7-05 agent assist and its article proposals, and M7-09's transcripts on a
 * ticket. Triage (M7-07) and transcription run in the worker.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class AssistModule {
  static forRoot({ env, http, transport }: AssistModuleOptions): DynamicModule {
    const repository = new AssistRepository();
    const aiRepository = new AiRepository();
    const budget = new BudgetMeter(aiRepository);
    return {
      module: AssistModule,
      controllers: [AssistController, ProposalsController],
      providers: [
        {
          provide: AssistService,
          inject: [DB, SETTINGS],
          useFactory: (db: Db, settings: Settings): AssistService => {
            const ai = createAiRuntime({
              db,
              settings,
              http: http ?? safeAiTransport(env.OUTBOUND_ALLOW_CIDRS),
              ...(transport === undefined ? {} : { transport }),
            });
            return new AssistService({
              db,
              ai,
              retriever: createRetriever({ db, embedQuery: createQueryEmbedder(db, ai) }),
              repository,
              budget,
            });
          },
        },
        {
          provide: AssistStateService,
          useFactory: (): AssistStateService =>
            new AssistStateService(repository, aiRepository, budget),
        },
        {
          provide: ProposalsService,
          useFactory: (): ProposalsService =>
            new ProposalsService(
              new ProposalsRepository(),
              repository,
              new HelpCenterArticlesService(new HelpCenterRepository()),
            ),
        },
      ],
    };
  }
}
