import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { StorePresenceReader } from '../assignment/presence-adapters.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { RulesRepository } from '../rules/rules.repository.js';
import { REDIS } from '../runtime/tokens.js';
import { BusinessHoursService } from '../sla/business-hours.service.js';
import { businessHoursProbe } from '../sla/business-hours-probe.js';
import { SlaService } from '../sla/sla.service.js';
import { RoutingController } from './routing.controller.js';
import { RoutingRepository } from './routing.repository.js';
import { RoutingService } from './routing.service.js';

export interface RoutingModuleOptions {
  /** `SlaModule.forRoot()`, built once by `AppModule`: policies, calendars and business hours. */
  readonly sla: DynamicModule;
}

/**
 * M14-09: the Routing tab and Test routing. Presence is read straight from
 * M0-13's Redis keys through a `PresenceStore` of this module's own, for the
 * reason `AssignmentModule` gives; the repositories are stateless.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class RoutingModule {
  static forRoot({ sla }: RoutingModuleOptions): DynamicModule {
    return {
      module: RoutingModule,
      imports: [sla],
      controllers: [RoutingController],
      providers: [
        {
          provide: RoutingService,
          inject: [SlaService, BusinessHoursService, REDIS],
          useFactory: (
            slaService: SlaService,
            businessHours: BusinessHoursService,
            redis: Redis,
          ): RoutingService =>
            new RoutingService({
              repository: new RoutingRepository(),
              rules: new RulesRepository(),
              assignment: new AssignmentRepository(),
              businessHours: businessHoursProbe(businessHours),
              sla: slaService,
              presence: new StorePresenceReader(new PresenceStore(redis)),
            }),
        },
      ],
    };
  }
}
