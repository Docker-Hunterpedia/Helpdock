import { createKeyring, type Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimiter } from '../auth/rate-limit.js';
import { DB, ENV, REDIS } from '../runtime/tokens.js';
import { CsatController } from './csat.controller.js';
import { CsatRepository } from './csat.repository.js';
import { CsatService } from './csat.service.js';
import { CsatTokens } from './tokens.js';

/**
 * M1-12's survey: the public rating routes, and the service the ticket detail
 * reads the agent's summary from.
 *
 * Built once by `AppModule` and imported twice, by `AppModule` for the
 * controller and by `TicketsModule` for {@link CsatService}, for the reason
 * `TicketingModule` is: a second `forRoot()` would be a second module, and its
 * controller would be registered twice.
 *
 * The lifecycle hook (`csat-hooks.ts`) is provided by `TicketsModule` rather
 * than here, because it needs `TicketLifecycleRepository`, which is that
 * module's.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class CsatModule {
  static forRoot(): DynamicModule {
    return {
      module: CsatModule,
      controllers: [CsatController],
      providers: [
        CsatRepository,
        {
          provide: CsatTokens,
          inject: [ENV],
          useFactory: (env: Env): CsatTokens => new CsatTokens(createKeyring(env)),
        },
        {
          provide: CsatService,
          inject: [DB, ENV, REDIS, CsatRepository, CsatTokens],
          useFactory: (
            db: Db,
            env: Env,
            redis: Redis,
            repository: CsatRepository,
            tokens: CsatTokens,
          ): CsatService =>
            new CsatService({
              db,
              repository,
              tokens,
              limiter: new RateLimiter(redis),
              appUrl: env.APP_URL,
            }),
        },
      ],
      exports: [CsatService],
    };
  }
}
