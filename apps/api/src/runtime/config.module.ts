import type { Env } from '@helpdock/config';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ENV } from './tokens.js';

/**
 * `@helpdock/config` already validates the environment and throws one error
 * listing every bad key. This module only hands the result to the injector; it
 * repeats none of that logic, because a second copy would be the one that goes
 * stale.
 *
 * The value arrives from boot rather than being loaded here: `loadEnv` runs
 * before Nest exists, since migrations and the runtime-role check both need it
 * (ARCHITECTURE §6).
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
