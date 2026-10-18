import { createKeyring, type Env } from '@helpdock/config';
import { ConnectorError, ImportRateLimiter } from '@helpdock/importers';
import {
  freshdeskCredentialsSchema,
  zendeskCredentialsSchema,
  zohoCredentialsSchema,
} from '@helpdock/schemas';
import { type DynamicModule, Module } from '@nestjs/common';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { ImportFilePresetsController } from './file-presets.controller.js';
import { ImportFilePresetsService } from './file-presets.service.js';
import { ImportFilesController } from './files.controller.js';
import { ImportFilesService } from './files.service.js';
import { ImportLogController } from './import-log.controller.js';
import { ImportsController } from './imports.controller.js';
import { type ImportConnectionFactory, ImportsService } from './imports.service.js';
import {
  createFreshdeskImportConnection,
  createZendeskImportConnection,
  createZohoImportConnection,
} from './jobs/connector-runtime.js';
import { ImportSlaActivationController } from './sla-activation.controller.js';

export interface ImportsModuleOverrides {
  readonly connection?: ImportConnectionFactory;
  readonly storage?: ObjectStorage;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules use a static forRoot factory.
export class ImportsModule {
  static forRoot(env: Env, overrides: ImportsModuleOverrides = {}): DynamicModule {
    return {
      module: ImportsModule,
      controllers: [
        ImportsController,
        ImportFilePresetsController,
        ImportFilesController,
        ImportLogController,
        ImportSlaActivationController,
      ],
      providers: [
        {
          provide: ImportFilesService,
          useFactory: () =>
            new ImportFilesService(
              overrides.storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET),
            ),
        },
        { provide: ImportFilePresetsService, useFactory: () => new ImportFilePresetsService() },
        {
          provide: ImportsService,
          useFactory: () =>
            new ImportsService(
              createKeyring(env),
              overrides.connection ??
                ((request, source) => {
                  const common = {
                    downloadHosts: request.downloadHosts,
                    limiter: new ImportRateLimiter({
                      capacity: source === 'zohodesk' ? 20 : 4,
                      perMinute: 60,
                    }),
                    allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
                    // Connection probes cannot write an extraction log without a worker claim.
                    log: async () => {
                      throw new ConnectorError('invalid-response');
                    },
                  };
                  if (source === 'zohodesk')
                    return createZohoImportConnection({
                      ...common,
                      credentials: zohoCredentialsSchema.parse(request.credentials),
                    });
                  return source === 'freshdesk'
                    ? createFreshdeskImportConnection({
                        ...common,
                        credentials: freshdeskCredentialsSchema.parse(request.credentials),
                      })
                    : createZendeskImportConnection({
                        ...common,
                        credentials: zendeskCredentialsSchema.parse(request.credentials),
                      });
                }),
            ),
        },
      ],
    };
  }
}
