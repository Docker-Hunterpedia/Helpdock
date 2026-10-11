import type { HttpTransport } from '@helpdock/ai';
import type { Env, Settings } from '@helpdock/config';
import type { LookupFunction } from '@helpdock/net';
import { type DynamicModule, Module } from '@nestjs/common';
import { SETTINGS } from '../runtime/tokens.js';
import { AiRepository } from './ai.repository.js';
import { createAiDestinationCheck } from './ai-destination.js';
import { safeAiTransport } from './ai-http.js';
import { AutoReplyStaffController, AutoReplyStaffService } from './auto-reply/auto-reply-staff.js';
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
  /** How a saved URL's host is resolved. The system resolver unless a suite passes a fake. */
  readonly lookup?: LookupFunction;
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
  static forRoot({ env, http, lookup }: AiModuleOptions): DynamicModule {
    const transport = http ?? safeAiTransport(env.OUTBOUND_ALLOW_CIDRS);
    const checkDestination = createAiDestinationCheck({
      allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
      ...(lookup === undefined ? {} : { lookup }),
    });
    return {
      module: AiModule,
      controllers: [InstallAiController, BrandAiController, AutoReplyStaffController],
      providers: [
        // M7-06's "Return to assistant".
        AutoReplyStaffService,
        {
          provide: InstallAiService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): InstallAiService =>
            new InstallAiService(settings, transport, checkDestination),
        },
        {
          provide: EmbeddingSettingsService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): EmbeddingSettingsService =>
            new EmbeddingSettingsService(settings, checkDestination),
        },
        {
          provide: TranscriptionSettingsService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): TranscriptionSettingsService =>
            new TranscriptionSettingsService(settings, checkDestination),
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
