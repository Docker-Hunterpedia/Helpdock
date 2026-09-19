import type { Settings } from '@helpdock/config';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS, SETTINGS } from './tokens.js';

/**
 * The install-scope settings resolver of ARCHITECTURE §4, already wired to the
 * `settings` table and to the Redis invalidation channel by boot, plus the
 * Redis client `/ready` probes.
 *
 * Per-brand settings resolve through a store bound to that brand
 * (`PostgresSettingsStore`), which is the milestone that puts brand settings in
 * admin, not this one.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class SettingsModule {
  static forRoot(settings: Settings, redis: Redis): DynamicModule {
    return {
      module: SettingsModule,
      providers: [
        { provide: SETTINGS, useValue: settings },
        { provide: REDIS, useValue: redis },
      ],
      exports: [SETTINGS, REDIS],
    };
  }
}
