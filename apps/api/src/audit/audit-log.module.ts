import { type DynamicModule, Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { AuditLogService } from './audit-log.service.js';

/** M3-08: the install-wide audit log viewer. Read-only; retention does the deleting. */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class AuditLogModule {
  static forRoot(): DynamicModule {
    return {
      module: AuditLogModule,
      controllers: [AuditLogController],
      providers: [
        {
          provide: AuditLogService,
          useFactory: (): AuditLogService => new AuditLogService(new AuditLogRepository()),
        },
      ],
    };
  }
}
