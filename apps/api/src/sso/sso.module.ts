import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS, SETTINGS } from '../runtime/tokens.js';
import { SsoService } from './sso.service.js';
import { SsoAdminController } from './sso-admin.controller.js';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules use decorated classes.
export class SsoModule {
  static forRoot(env: Env, db: Db): DynamicModule {
    return {
      module: SsoModule,
      controllers: [SsoAdminController],
      providers: [
        {
          provide: SsoService,
          inject: [SETTINGS, REDIS],
          useFactory: (settings: Settings, redis: Redis) =>
            new SsoService({ env, db, settings, redis, keyring: createKeyring(env) }),
        },
      ],
      exports: [SsoService],
    };
  }
}
