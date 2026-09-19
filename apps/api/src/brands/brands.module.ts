import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { BrandsController } from './brands.controller.js';
import { BrandsService } from './brands.service.js';
import { DepartmentsController } from './departments.controller.js';
import { DepartmentsRepository } from './departments.repository.js';
import { DepartmentsService } from './departments.service.js';
import { InstallBrandsService } from './install-brands.service.js';

/**
 * M1-01: brands, departments, teams and team members (REQUIREMENTS §3).
 *
 * One module for the brand and everything hanging off it, so `app.module.ts`
 * gains one import and `department-scope.ts` stays the single answer to "who
 * may change this?".
 *
 * The services are wired by hand, as `StaffModule` wires its own and for the
 * same reason: the only dependency that does not come from the injector is the
 * process logger, which arrives from boot as a value.
 */

export interface BrandsModuleOptions {
  /**
   * The process logger. A value rather than an injected provider because
   * `LOGGER` belongs to `AppModule`, which an imported module cannot see.
   */
  readonly logger: Logger;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class BrandsModule {
  static forRoot({ logger }: BrandsModuleOptions): DynamicModule {
    return {
      module: BrandsModule,
      controllers: [BrandsController, DepartmentsController],
      providers: [
        BrandsService,
        {
          provide: DepartmentsRepository,
          useFactory: (): DepartmentsRepository => new DepartmentsRepository(),
        },
        {
          provide: DepartmentsService,
          inject: [DepartmentsRepository],
          useFactory: (repository: DepartmentsRepository): DepartmentsService =>
            new DepartmentsService(repository),
        },
        {
          provide: InstallBrandsService,
          useFactory: (): InstallBrandsService => new InstallBrandsService(logger),
        },
      ],
    };
  }
}
