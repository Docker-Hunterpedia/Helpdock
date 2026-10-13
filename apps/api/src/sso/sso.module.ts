import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from '../logging/logger.js';
import { REDIS, SETTINGS } from '../runtime/tokens.js';
import { SsoIdentityService } from './identity.service.js';
import { OidcService } from './oidc.service.js';
import { SamlService } from './saml.service.js';
import { SsoService } from './sso.service.js';
import { SsoAdminController } from './sso-admin.controller.js';
import { SsoOidcController } from './sso-oidc.controller.js';
import { SsoSamlController } from './sso-saml.controller.js';
import { SsoSessionCompletion } from './sso-session-completion.js';
import { SsoTestSignInService } from './test-sign-in.service.js';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules use decorated classes.
export class SsoModule {
  static forRoot(env: Env, db: Db, logger: Logger): DynamicModule {
    return {
      module: SsoModule,
      controllers: [SsoAdminController, SsoOidcController, SsoSamlController],
      providers: [
        SsoSessionCompletion,
        {
          provide: SsoTestSignInService,
          inject: [REDIS, SsoIdentityService, SsoService],
          useFactory: (redis: Redis, identities: SsoIdentityService, sso: SsoService) =>
            new SsoTestSignInService({ redis, env, identities, sso }),
        },
        {
          provide: SamlService,
          inject: [REDIS, SsoService],
          useFactory: (redis: Redis, sso: SsoService) =>
            new SamlService({ env, db, redis, sso, logger }),
        },
        {
          provide: OidcService,
          inject: [REDIS],
          useFactory: (redis: Redis) =>
            new OidcService({ env, db, redis, logger, keyring: createKeyring(env) }),
        },
        {
          provide: SsoService,
          inject: [SETTINGS, REDIS],
          useFactory: (settings: Settings, redis: Redis) =>
            new SsoService({ env, db, settings, redis, keyring: createKeyring(env) }),
        },
      ],
      exports: [SsoService, OidcService],
    };
  }
}
