import {
  importBrandParamSchema,
  importConnectionRequestSchema,
  importConnectionResultSchema,
  importContactPreviewQuerySchema,
  importContactPreviewSchema,
  importMappingsRequestSchema,
  importMappingsViewSchema,
  importPreviewSamplesSchema,
  importRunCreateSchema,
  importRunListSchema,
  importRunParamSchema,
  importRunViewSchema,
  importScopeSchema,
  importTicketPreviewQuerySchema,
  importTicketPreviewSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';
export class ImportBrandParamDto extends createZodDto(importBrandParamSchema) {}
export class ImportRunParamDto extends createZodDto(importRunParamSchema) {}
export class ImportRunCreateDto extends createZodDto(importRunCreateSchema) {}
export class ImportConnectionRequestDto extends createZodDto(importConnectionRequestSchema) {}
export class ImportRunViewDto extends createZodDto(importRunViewSchema) {}
export class ImportRunListDto extends createZodDto(importRunListSchema) {}
export class ImportConnectionResultDto extends createZodDto(importConnectionResultSchema) {}

export class ImportScopeDto extends createZodDto(importScopeSchema) {}

export class ImportMappingsRequestDto extends createZodDto(importMappingsRequestSchema) {}
export class ImportMappingsViewDto extends createZodDto(importMappingsViewSchema) {}
export class ImportTicketPreviewQueryDto extends createZodDto(importTicketPreviewQuerySchema) {}
export class ImportTicketPreviewDto extends createZodDto(importTicketPreviewSchema) {}
export class ImportContactPreviewQueryDto extends createZodDto(importContactPreviewQuerySchema) {}
export class ImportContactPreviewDto extends createZodDto(importContactPreviewSchema) {}
export class ImportPreviewSamplesDto extends createZodDto(importPreviewSamplesSchema) {}
