import {
  importBrandParamSchema,
  importConnectionRequestSchema,
  importConnectionResultSchema,
  importContactPreviewQuerySchema,
  importContactPreviewSchema,
  importDryRunReportSchema,
  importDryRunRequestSchema,
  importFieldSchema,
  importMappingFieldQuerySchema,
  importMappingPageRequestSchema,
  importMappingPageResultSchema,
  importMappingsRequestSchema,
  importMappingsViewSchema,
  importMappingTargetsQuerySchema,
  importMappingTargetsSchema,
  importMappingValuesQuerySchema,
  importMappingValuesSchema,
  importPreviewSamplesSchema,
  importRunCreateSchema,
  importRunListSchema,
  importRunParamSchema,
  importRunViewSchema,
  importScopeSchema,
  importStartRequestSchema,
  importSupportedSourcesSchema,
  importTicketPreviewQuerySchema,
  importTicketPreviewSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';
export class ImportBrandParamDto extends createZodDto(importBrandParamSchema) {}
export class ImportSupportedSourcesDto extends createZodDto(importSupportedSourcesSchema) {}
export class ImportRunParamDto extends createZodDto(importRunParamSchema) {}
export class ImportRunCreateDto extends createZodDto(importRunCreateSchema) {}
export class ImportConnectionRequestDto extends createZodDto(importConnectionRequestSchema) {}
export class ImportRunViewDto extends createZodDto(importRunViewSchema) {}
export class ImportRunListDto extends createZodDto(importRunListSchema) {}
export class ImportConnectionResultDto extends createZodDto(importConnectionResultSchema) {}

export class ImportScopeDto extends createZodDto(importScopeSchema) {}

export class ImportMappingsRequestDto extends createZodDto(importMappingsRequestSchema) {}
export class ImportMappingValuesQueryDto extends createZodDto(importMappingValuesQuerySchema) {}
export class ImportMappingValuesDto extends createZodDto(importMappingValuesSchema) {}
export class ImportMappingTargetsQueryDto extends createZodDto(importMappingTargetsQuerySchema) {}
export class ImportMappingTargetsDto extends createZodDto(importMappingTargetsSchema) {}
export class ImportMappingFieldQueryDto extends createZodDto(importMappingFieldQuerySchema) {}
export class ImportMappingSourceFieldDto extends createZodDto(importFieldSchema) {}
export class ImportMappingPageRequestDto extends createZodDto(importMappingPageRequestSchema) {}
export class ImportMappingPageResultDto extends createZodDto(importMappingPageResultSchema) {}
export class ImportMappingsViewDto extends createZodDto(importMappingsViewSchema) {}
export class ImportTicketPreviewQueryDto extends createZodDto(importTicketPreviewQuerySchema) {}
export class ImportTicketPreviewDto extends createZodDto(importTicketPreviewSchema) {}
export class ImportContactPreviewQueryDto extends createZodDto(importContactPreviewQuerySchema) {}
export class ImportContactPreviewDto extends createZodDto(importContactPreviewSchema) {}
export class ImportPreviewSamplesDto extends createZodDto(importPreviewSamplesSchema) {}

export class ImportDryRunRequestDto extends createZodDto(importDryRunRequestSchema) {}

export class ImportDryRunReportDto extends createZodDto(importDryRunReportSchema) {}

export class ImportStartRequestDto extends createZodDto(importStartRequestSchema) {}
