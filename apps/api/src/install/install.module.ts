import type { Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PasswordHasher } from '../auth/password.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { SessionService } from '../auth/session/session.service.js';
import type { Logger } from '../logging/logger.js';
import { DB, REDIS, SETTINGS } from '../runtime/tokens.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';
import { SetupTokenStore } from './setup-token.store.js';

/**
 * M0-08. Everything under `/api/install/setup`.
 *
 * It imports the already-built `AuthModule` rather than a second copy of it:
 * the wizard opens an ordinary session for the admin it creates, and the
 * password it hashes has to use the same pepper as every later sign-in, so both
 * come from the one auth graph `AppModule` built (`auth.module.ts`).
 */

export interface InstallModuleOptions {
  /**
   * The exact `AuthModule.forRoot(...)` value `AppModule` imports. Passing the
   * same object is what makes Nest treat it as one module: calling `forRoot`
   * again here would build a second `SessionService` over the same Redis.
   */
  readonly auth: DynamicModule;
  /**
   * The process logger, handed over rather than injected: `LOGGER` is a
   * provider of `AppModule` itself, which an imported module cannot see.
   */
  readonly logger: Logger;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class InstallModule {
  static forRoot({ auth, logger }: InstallModuleOptions): DynamicModule {
    return {
      module: InstallModule,
      imports: [auth],
      controllers: [SetupController],
      providers: [
        {
          provide: SetupService,
          inject: [DB, SETTINGS, REDIS, SessionService, PasswordHasher],
          useFactory: (
            db: Db,
            settings: Settings,
            redis: Redis,
            sessions: SessionService,
            hasher: PasswordHasher,
          ): SetupService =>
            new SetupService({
              db,
              settings,
              hasher,
              sessions,
              tokens: new SetupTokenStore(redis),
              limiter: new RateLimiter(redis),
              logger,
            }),
        },
      ],
    };
  }
}
