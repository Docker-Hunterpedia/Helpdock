import { createKeyring, type Env } from '@helpdock/config';
import { ConnectorError, ImportRateLimiter } from '@helpdock/importers';
import { type DynamicModule, Module } from '@nestjs/common';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';
import { createZendeskImportConnection } from './jobs/connector-runtime.js';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules use a static forRoot factory.
export class ImportsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ImportsModule,
      controllers: [ImportsController],
      providers: [
        {
          provide: ImportsService,
          useFactory: () =>
            new ImportsService(createKeyring(env), (request) =>
              createZendeskImportConnection({
                credentials: request.credentials,
                downloadHosts: request.downloadHosts,
                limiter: new ImportRateLimiter({ capacity: 1, perMinute: 60 }),
                allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
                // Connection tests read only /users/me; extraction logs belong to a claimed worker.
                log: async () => {
                  throw new ConnectorError('invalid-response');
                },
              }),
            ),
        },
      ],
    };
  }
}
