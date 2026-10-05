import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AI_USAGE_SOURCE, type AiUsageSource, NoAiUsage } from './ai-usage.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

export interface ReportsModuleOptions {
  /** The `ai_calls` reader (`DbAiUsage`); without one every AI number reads "not available". */
  readonly aiUsage?: AiUsageSource;
}

/**
 * M8-04: the Reports routes. The rollups behind them are written by the
 * worker's `stats.rollup` job (`rollup.job.ts`).
 *
 * Global because {@link AI_USAGE_SOURCE} is read by the System page as well
 * (M8-05), and one binding is what keeps the two from disagreeing.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ReportsModule {
  static forRoot({ aiUsage = new NoAiUsage() }: ReportsModuleOptions = {}): DynamicModule {
    return {
      module: ReportsModule,
      controllers: [ReportsController],
      providers: [
        { provide: AI_USAGE_SOURCE, useValue: aiUsage },
        {
          provide: ReportsService,
          inject: [AI_USAGE_SOURCE],
          useFactory: (ai: AiUsageSource): ReportsService => new ReportsService(ai),
        },
      ],
      exports: [AI_USAGE_SOURCE],
    };
  }
}
