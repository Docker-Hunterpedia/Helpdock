import type { Env } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { BrandHostResolver } from './brand-host.js';
import { cnameTargetOf, ownHostsOf } from './domain-config.js';
import { DomainsController } from './domains.controller.js';
import { DomainsRepository } from './domains.repository.js';
import { DomainsService } from './domains.service.js';

/**
 * M5-07 in the api: Brand › Domains, and the `Host` → brand map.
 *
 * The resolver is built by `AppModule`, which also hands it to the request
 * middleware as the install's `BrandResolver`, and is exported from here under
 * its own class so the help center SSR (M5-03) can inject it and read the
 * primary host with the brand. The DNS and TLS check runs in the worker
 * (`domain-jobs.ts`).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class DomainsModule {
  static forRoot(options: {
    readonly env: Env;
    readonly hostResolver: BrandHostResolver;
  }): DynamicModule {
    const { env, hostResolver } = options;

    return {
      module: DomainsModule,
      controllers: [DomainsController],
      providers: [
        {
          provide: DomainsService,
          useFactory: (): DomainsService =>
            new DomainsService({
              repository: new DomainsRepository(),
              cnameTarget: cnameTargetOf(env),
              reservedHosts: ownHostsOf(env),
            }),
        },
        { provide: BrandHostResolver, useValue: hostResolver },
      ],
      exports: [BrandHostResolver],
    };
  }
}
