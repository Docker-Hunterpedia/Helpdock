import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import { DB } from '../runtime/tokens.js';
import { PortalAdminController } from './portal-admin.controller.js';
import { PortalAdminRepository } from './portal-admin.repository.js';
import { PortalAdminService } from './portal-admin.service.js';

/**
 * M21-06: Settings › Channels › Customer portal, an account's visibility, a
 * contact's portal access and the private mark on a ticket. The customer-facing
 * half is `apps/api/src/portal`; nothing here runs on a customer's request.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class PortalAdminModule {
  static forRoot(): DynamicModule {
    return {
      module: PortalAdminModule,
      controllers: [PortalAdminController],
      providers: [
        {
          provide: PortalAdminService,
          inject: [DB],
          useFactory: (db: Db): PortalAdminService =>
            new PortalAdminService(new PortalAdminRepository(), db),
        },
      ],
    };
  }
}
