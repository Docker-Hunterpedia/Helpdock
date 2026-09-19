import type { Env, Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthService } from '../auth/auth.service.js';
import { EmailTokenStore } from '../auth/email-token.store.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { SessionService } from '../auth/session/session.service.js';
import type { Logger } from '../logging/logger.js';
import { DB, ENV, REDIS, SETTINGS } from '../runtime/tokens.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { InstallStaffController } from './install-staff.controller.js';
import { InstallStaffService } from './install-staff.service.js';
import { InviteService } from './invite.service.js';
import { InviteStore } from './invite.store.js';
import { InvitesController } from './invites.controller.js';
import { LoggingStaffLifecycleHooks } from './lifecycle-hooks.js';
import { StaffController } from './staff.controller.js';
import { StaffRepository } from './staff.repository.js';
import { StaffService } from './staff.service.js';

/**
 * M0-06: roles and the staff lifecycle (DOMAIN-RULES §12).
 *
 * One module for four surfaces that share the same rules — the brand's staff
 * list, the public invite, an install admin's delete, and a person's own
 * account — so that `staff-scope.ts` is the single answer to "who may do this"
 * and `app.module.ts` gains one import.
 *
 * The services are wired by hand, as `AuthModule` wires its own and for the
 * same reason: their dependencies arrive from boot as values, and a factory per
 * service would be the same wiring written twice. `AuthService` and
 * `SessionService` are injected rather than rebuilt — the pepper, the keyring
 * and the signing keys exist once per process.
 */

export interface StaffModuleOptions {
  /**
   * The process logger. A value rather than an injected provider because
   * `LOGGER` belongs to `AppModule`, which an imported module cannot see.
   */
  readonly logger: Logger;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class StaffModule {
  static forRoot({ logger }: StaffModuleOptions): DynamicModule {
    return {
      module: StaffModule,
      controllers: [StaffController, InvitesController, AccountController, InstallStaffController],
      providers: [
        {
          provide: StaffRepository,
          useFactory: (): StaffRepository => new StaffRepository(),
        },
        {
          provide: InviteStore,
          inject: [REDIS],
          useFactory: (redis: Redis): InviteStore => new InviteStore(redis),
        },
        {
          provide: EmailTokenStore,
          inject: [REDIS],
          useFactory: (redis: Redis): EmailTokenStore => new EmailTokenStore(redis),
        },
        {
          provide: RateLimiter,
          inject: [REDIS],
          useFactory: (redis: Redis): RateLimiter => new RateLimiter(redis),
        },
        {
          provide: StaffService,
          inject: [
            StaffRepository,
            InviteStore,
            EmailTokenStore,
            SessionService,
            AuthService,
            RateLimiter,
            SETTINGS,
            ENV,
          ],
          useFactory: (
            staff: StaffRepository,
            invites: InviteStore,
            tokens: EmailTokenStore,
            sessions: SessionService,
            auth: AuthService,
            limiter: RateLimiter,
            settings: Settings,
            env: Env,
          ): StaffService =>
            new StaffService({
              staff,
              invites,
              tokens,
              sessions,
              auth,
              limiter,
              settings,
              hooks: new LoggingStaffLifecycleHooks(logger),
              logger,
              appUrl: env.APP_URL,
            }),
        },
        {
          provide: InviteService,
          inject: [DB, StaffRepository, InviteStore, EmailTokenStore, AuthService, RateLimiter],
          useFactory: (
            db: Db,
            staff: StaffRepository,
            invites: InviteStore,
            tokens: EmailTokenStore,
            auth: AuthService,
            limiter: RateLimiter,
          ): InviteService =>
            new InviteService({ db, staff, invites, tokens, auth, limiter, logger }),
        },
        {
          provide: AccountService,
          inject: [StaffRepository, AuthService, SessionService, SETTINGS],
          useFactory: (
            staff: StaffRepository,
            auth: AuthService,
            sessions: SessionService,
            settings: Settings,
          ): AccountService => new AccountService({ staff, auth, sessions, settings, logger }),
        },
        {
          provide: InstallStaffService,
          inject: [StaffRepository, AuthService],
          useFactory: (staff: StaffRepository, auth: AuthService): InstallStaffService =>
            new InstallStaffService({ staff, auth, logger }),
        },
      ],
    };
  }
}
