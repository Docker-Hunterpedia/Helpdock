import type { AuditLogPage } from '@helpdock/schemas';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { AuditLogService } from './audit-log.service.js';
import { AuditLogPageDto, AuditLogQueryDto } from './dto.js';

/**
 * The audit log page under System (M3-08).
 *
 * `@Requires('install:admin')`, like the rest of System: the page is
 * install-wide, and a brand's Admin has no business reading another brand's
 * trail. The route therefore runs in install scope, and the tenant interceptor
 * writes its `install.scope.access` row before the handler runs.
 *
 * There is no write route. Rows are removed by retention alone.
 */
@Controller('api')
export class AuditLogController {
  readonly #audit: AuditLogService;

  constructor(@Inject(AuditLogService) audit: AuditLogService) {
    this.#audit = audit;
  }

  @Get('install/audit-log')
  @Requires('install:admin')
  @ZodSerializerDto(AuditLogPageDto)
  page(
    @Query(new ZodValidationPipe(AuditLogQueryDto)) query: AuditLogQueryDto,
  ): Promise<AuditLogPage> {
    return this.#audit.page(query);
  }
}
