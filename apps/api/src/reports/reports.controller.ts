import { Readable } from 'node:stream';
import {
  brandIdParamSchema,
  type ReportSummary,
  reportExportFileName,
  reportExportParamSchema,
  reportQuerySchema,
  reportSummarySchema,
} from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Query, StreamableFile } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { ReportsService } from './reports.service.js';

class ReportParamDto extends createZodDto(brandIdParamSchema) {}
class ReportExportParamDto extends createZodDto(reportExportParamSchema) {}
class ReportQueryDto extends createZodDto(reportQuerySchema) {}
class ReportSummaryDto extends createZodDto(reportSummarySchema) {}

/**
 * Reports (M8-04). `report:read` is an Admin's, a Team Leader's and a
 * Viewer's; which departments' numbers they get is the rollups' row-level
 * security, so a Team Leader asking for a department they do not lead gets
 * zeroes rather than another team's figures.
 */
@Controller('api/brands/:brandId/reports')
export class ReportsController {
  readonly #reports: ReportsService;

  constructor(@Inject(ReportsService) reports: ReportsService) {
    this.#reports = reports;
  }

  @Get()
  @Requires('report:read')
  @ZodSerializerDto(ReportSummaryDto)
  summary(
    @Param(new ZodValidationPipe(ReportParamDto)) { brandId }: ReportParamDto,
    @Query(new ZodValidationPipe(ReportQueryDto)) query: ReportQueryDto,
  ): Promise<ReportSummary> {
    return this.#reports.summary(getTx(), brandId, query);
  }

  /** One report as CSV, every row (`report-exports.ts`). */
  @Get('exports/:report')
  @Requires('report:read')
  async export(
    @Param(new ZodValidationPipe(ReportExportParamDto)) { brandId, report }: ReportExportParamDto,
    @Query(new ZodValidationPipe(ReportQueryDto)) query: ReportQueryDto,
  ): Promise<StreamableFile> {
    const lines = await this.#reports.export(getTx(), brandId, report, query);

    return new StreamableFile(Readable.from(lines), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${reportExportFileName(report, query.from, query.to)}"`,
    });
  }
}
