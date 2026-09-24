import {
  brandIdParamSchema,
  retentionOverviewSchema,
  retentionUpdateRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The retention schemas as Nest DTOs, for the reason `brands/dto.ts` gives. */
export class RetentionBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class RetentionOverviewDto extends createZodDto(retentionOverviewSchema) {}
export class RetentionUpdateRequestDto extends createZodDto(retentionUpdateRequestSchema) {}
