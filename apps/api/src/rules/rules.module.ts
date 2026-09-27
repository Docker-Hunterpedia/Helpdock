import { type DynamicModule, Module } from '@nestjs/common';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import {
  alwaysOpen,
  type BusinessHoursProbe,
  type CannedResponseCatalog,
  noCannedResponseCatalog,
} from './ports.js';
import { RulesController } from './rules.controller.js';
import { RulesRepository } from './rules.repository.js';
import { RulesService } from './rules.service.js';

export interface RulesModuleOptions {
  /** M3-01's calendar, for the test run's "business hours" condition. */
  readonly businessHours?: BusinessHoursProbe;
  /** M3-06's canned responses, for the builder's select. */
  readonly cannedResponses?: CannedResponseCatalog;
}

/**
 * M3-03 to M3-05, the api half: the builder's routes. The engine itself runs in
 * the worker (`rules-jobs.ts`), because rules run from the outbox relay's
 * domain events and never from a request.
 *
 * The repositories are stateless — every statement takes the request's
 * transaction — so instances of their own cost nothing, as `ViewsModule` says.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class RulesModule {
  static forRoot({
    businessHours = alwaysOpen,
    cannedResponses = noCannedResponseCatalog,
  }: RulesModuleOptions = {}): DynamicModule {
    return {
      module: RulesModule,
      controllers: [RulesController],
      providers: [
        {
          provide: RulesService,
          useFactory: (): RulesService =>
            new RulesService({
              rules: new RulesRepository(),
              assignment: new AssignmentRepository(),
              businessHours,
              cannedResponses,
            }),
        },
      ],
    };
  }
}
