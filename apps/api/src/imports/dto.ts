import {
  importBrandParamSchema,
  importConnectionRequestSchema,
  importConnectionResultSchema,
  importMappingsRequestSchema,
  importMappingsViewSchema,
  importRunCreateSchema,
  importRunListSchema,
  importRunParamSchema,
  importRunViewSchema,
  importScopeSchema,
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
