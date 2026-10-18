import { Readable } from 'node:stream';
import { type Db, withTenant } from '@helpdock/db';
import {
  importLogExportQuerySchema,
  importLogPageSchema,
  importLogQuerySchema,
  importRunParamSchema,
} from '@helpdock/schemas';
import { Controller, Get, Header, Inject, Param, Query, StreamableFile } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import { DB } from '../runtime/tokens.js';
import { inRequestTenant, StepTransactions } from '../tenant/step-transactions.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import { exportImportLog, readImportLog } from './import-log.js';

class RunParamDto extends createZodDto(importRunParamSchema) {}
class LogQueryDto extends createZodDto(importLogQuerySchema) {}
class LogPageDto extends createZodDto(importLogPageSchema) {}
class LogExportQueryDto extends createZodDto(importLogExportQuerySchema) {}

@Controller('api/brands/:brandId/imports/:runId/log')
export class ImportLogController {
  constructor(@Inject(DB) readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Requires('brand:manage')
  @ZodSerializerDto(LogPageDto)
  list(
    @Param(new ZodValidationPipe(RunParamDto)) scope: RunParamDto,
    @Query(new ZodValidationPipe(LogQueryDto)) query: LogQueryDto,
  ) {
    return readImportLog(requireTicketingContext().tx, scope, query);
  }

  @Get('export')
  @Header('Cache-Control', 'no-store')
  @Requires('brand:manage')
  @StepTransactions()
  async export(
    @Param(new ZodValidationPipe(RunParamDto)) scope: RunParamDto,
    @Query(new ZodValidationPipe(LogExportQueryDto)) query: LogExportQueryDto,
  ) {
    const tenant = requireRequestContext().tenant;
    if (!tenant) throw new Error('An import log export ran without its request tenant');
    const first = await inRequestTenant(this.db, (tx) =>
      readImportLog(tx, scope, { ...query, direction: 'asc', limit: 500 }),
    );
    const lines = exportImportLog(
      first,
      (page) => withTenant(this.db, tenant, (tx) => readImportLog(tx, scope, page)),
      query.level,
    );
    return new StreamableFile(Readable.from(lines), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="helpdock-import-${scope.runId}.csv"`,
    });
  }
}
