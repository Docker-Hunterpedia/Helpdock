import type { HttpTransport } from '@helpdock/ai';
import type { Env, Settings } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { SETTINGS } from '../runtime/tokens.js';
import { AiRepository } from './ai.repository.js';
import { safeAiTransport } from './ai-http.js';
import { BrandAiController } from './brand-ai.controller.js';
import { BrandAiService } from './brand-ai.service.js';
import { BudgetMeter } from './budget-meter.js';
import { EmbeddingSettingsService } from './embedding-settings.service.js';
import { InstallAiController } from './install-ai.controller.js';
import { InstallAiService } from './install-ai.service.js';
import { TranscriptionSettingsService } from './transcription-settings.service.js';

export interface AiModuleOptions {
  readonly env: Pick<Env, 'OUTBOUND_ALLOW_CIDRS'>;
  /** The HTTP model discovery goes through. The SSRF-safe client unless a suite passes a fake. */
  readonly http?: HttpTransport;
}

/**
 * M7-01, M7-02, M7-08's http half: providers, the default and the embedding
 * model, a brand's assistant settings and a ticket's AI log. Model calls
 * themselves are made by the features that need them, through
 * `createAiRuntime` (`db-ai-ports.ts`); re-embedding runs in the worker.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class AiModule {
  static forRoot({ env, http }: AiModuleOptions): DynamicModule {
    const transport = http ?? safeAiTransport(env.OUTBOUND_ALLOW_CIDRS);
    return {
      module: AiModule,
      controllers: [InstallAiController, BrandAiController],
      providers: [
        {
          provide: InstallAiService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): InstallAiService =>
            new InstallAiService(settings, transport),
        },
        {
          provide: EmbeddingSettingsService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): EmbeddingSettingsService =>
            new EmbeddingSettingsService(settings),
        },
        {
          provide: TranscriptionSettingsService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): TranscriptionSettingsService =>
            new TranscriptionSettingsService(settings),
        },
        {
          provide: BrandAiService,
          inject: [InstallAiService],
          useFactory: (install: InstallAiService): BrandAiService => {
            const repository = new AiRepository();
            return new BrandAiService(repository, new BudgetMeter(repository), install);
          },
        },
      ],
    };
  }
}
