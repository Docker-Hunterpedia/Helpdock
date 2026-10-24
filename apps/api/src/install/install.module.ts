import type { Env, Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { MICROSOFT_CONSUMERS_TENANT_ID } from '@helpdock/schemas';
import { type DynamicModule, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { OauthIdentityRepository } from '../auth/oauth/oauth-identity.repository.js';
import { PasswordHasher } from '../auth/password.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { SessionService } from '../auth/session/session.service.js';
import type { Logger } from '../logging/logger.js';
import { DB, ENV, REDIS, SETTINGS } from '../runtime/tokens.js';
import { InstallSettingsController } from './settings.controller.js';
import { InstallSettingsService } from './settings.service.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';
import { SetupTokenStore } from './setup-token.store.js';
import { SmtpSettingsService } from './smtp-settings.service.js';

/**
 * M0-08's first-run setup and M0-02's install-wide Settings API.
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

/**
 * Counts, at boot, Microsoft identities bound to a tenant the install no longer
 * accepts, and logs one warning. It writes nothing and emails nobody: such rows
 * cannot sign anyone in, and each is replaced when its holder connects Microsoft
 * again or first-links at sign-in. A failure here is logged and never stops boot.
 */
class StrandedMicrosoftIdentityNotice implements OnApplicationBootstrap {
  constructor(
    private readonly settings: Settings,
    private readonly identities: OauthIdentityRepository,
    private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const [tenantId, allowConsumers] = await Promise.all([
        this.settings.get('oauth.microsoft.tenantId'),
        this.settings.get('oauth.microsoft.allowConsumers'),
      ]);
      const stranded = await this.identities.countMicrosoftOutside(
        tenantId === ''
          ? []
          : [tenantId, ...(allowConsumers ? [MICROSOFT_CONSUMERS_TENANT_ID] : [])],
      );
      if (stranded > 0) {
        this.logger.warn(
          { stranded },
          'Microsoft sign-in accounts are bound to a tenant this install no longer accepts; each is replaced when its holder connects Microsoft again',
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Could not count stranded Microsoft identities at boot');
    }
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class InstallModule {
  static forRoot({ auth, logger }: InstallModuleOptions): DynamicModule {
    return {
      module: InstallModule,
      imports: [auth],
      controllers: [SetupController, InstallSettingsController],
      providers: [
        {
          provide: InstallSettingsService,
          inject: [SETTINGS, ENV],
          useFactory: (settings: Settings, env: Env): InstallSettingsService =>
            new InstallSettingsService(settings, env),
        },
        {
          provide: SmtpSettingsService,
          inject: [SETTINGS, REDIS],
          useFactory: (settings: Settings, redis: Redis): SmtpSettingsService =>
            new SmtpSettingsService({
              settings,
              limiter: new RateLimiter(redis),
              logger,
            }),
        },
        {
          provide: StrandedMicrosoftIdentityNotice,
          inject: [SETTINGS, DB],
          useFactory: (settings: Settings, db: Db) =>
            new StrandedMicrosoftIdentityNotice(
              settings,
              new OauthIdentityRepository({ db }),
              logger,
            ),
        },
        {
          provide: SetupService,
          inject: [DB, SETTINGS, REDIS, SessionService, PasswordHasher, ENV],
          useFactory: (
            db: Db,
            settings: Settings,
            redis: Redis,
            sessions: SessionService,
            hasher: PasswordHasher,
            env: Env,
          ): SetupService =>
            new SetupService({
              db,
              settings,
              hasher,
              sessions,
              tokens: new SetupTokenStore(redis),
              limiter: new RateLimiter(redis),
              logger,
              setupKey: env.HD_SETUP_TOKEN,
            }),
        },
      ],
    };
  }
}
