import type { Env } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { ADMIN_DIST, LOGGER } from '../runtime/tokens.js';
import { resolveAdminDist } from './admin-assets.js';
import { AdminSpaController } from './admin-spa.controller.js';
import { InstallInfoService } from './install-info.service.js';

export interface StaticModuleOptions {
  readonly env: Pick<Env, 'ADMIN_DIST_DIR'>;
  readonly logger: Logger;
}

/**
 * Serves the admin SPA from the api (ARCHITECTURE §3). The build directory is
 * resolved once, at boot: `bootstrap.ts` registers `@fastify/static` against the
 * same directory, and both call {@link resolveAdminDist} so they can never
 * disagree about whether there is a build to serve.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class StaticModule {
  static forRoot({ env, logger }: StaticModuleOptions): DynamicModule {
    return {
      module: StaticModule,
      controllers: [AdminSpaController],
      providers: [
        { provide: ADMIN_DIST, useValue: resolveAdminDist(env.ADMIN_DIST_DIR) },
        // `ENV` and `DB` come from the two `@Global()` runtime modules; the
        // logger is an ordinary provider of `AppModule`, which a child module
        // cannot see, so it is handed over here rather than made global.
        { provide: LOGGER, useValue: logger },
        InstallInfoService,
      ],
    };
  }
}
