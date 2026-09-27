import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessHoursController } from './business-hours.controller.js';
import { BusinessHoursService } from './business-hours.service.js';
import { SlaRepository } from './sla.repository.js';
import { SlaService } from './sla.service.js';
import { SlaPoliciesController } from './sla-policies.controller.js';
import { SlaPoliciesService } from './sla-policies.service.js';

/**
 * M3-01 and M3-02 in one import: the Business hours and SLAs tabs, and the
 * engine behind them.
 *
 * `SlaService` and `BusinessHoursService` are exported. `TicketsModule` runs
 * the clocks through the first, via its lifecycle hooks; the second is the
 * `calendarFor(brandId, departmentId)` seam M2's out-of-hours auto-reply and
 * M3-04's time-based conditions read.
 *
 * Built once by `AppModule` and imported twice, for the reason `CsatModule`
 * is. Every class here is a plain class wired by hand, because the worker —
 * which runs no Nest application — builds the same engine with `new`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class SlaModule {
  static forRoot(): DynamicModule {
    return {
      module: SlaModule,
      controllers: [BusinessHoursController, SlaPoliciesController],
      providers: [
        { provide: SlaRepository, useFactory: (): SlaRepository => new SlaRepository() },
        {
          provide: SlaService,
          inject: [SlaRepository],
          useFactory: (repository: SlaRepository): SlaService => new SlaService(repository),
        },
        {
          provide: BusinessHoursService,
          inject: [SlaRepository, SlaService],
          useFactory: (repository: SlaRepository, sla: SlaService): BusinessHoursService =>
            new BusinessHoursService(repository, sla),
        },
        {
          provide: SlaPoliciesService,
          inject: [SlaRepository, SlaService],
          useFactory: (repository: SlaRepository, sla: SlaService): SlaPoliciesService =>
            new SlaPoliciesService(repository, sla),
        },
      ],
      exports: [SlaService, BusinessHoursService],
    };
  }
}
