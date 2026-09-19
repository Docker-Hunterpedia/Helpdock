import {
  brandCreateRequestSchema,
  brandIdParamSchema,
  brandListSchema,
  brandSchema,
  brandUpdateRequestSchema,
  departmentCreateRequestSchema,
  departmentParamSchema,
  departmentReorderRequestSchema,
  departmentSummaryListSchema,
  departmentSummarySchema,
  departmentUpdateRequestSchema,
  eligibleMemberListSchema,
  teamCreateRequestSchema,
  teamListSchema,
  teamMemberAddRequestSchema,
  teamMemberParamSchema,
  teamParamSchema,
  teamUpdateRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The brand and ticketing schemas as Nest DTOs, declared here for the reason
 * `routes/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 *
 * Every handler names an output DTO with `@ZodSerializerDto`, so a column a
 * later milestone adds cannot leak by being returned (ARCHITECTURE §6, step 5).
 */

export class BrandDto extends createZodDto(brandSchema) {}
export class BrandListDto extends createZodDto(brandListSchema) {}
export class BrandIdParamDto extends createZodDto(brandIdParamSchema) {}
export class BrandUpdateRequestDto extends createZodDto(brandUpdateRequestSchema) {}
export class BrandCreateRequestDto extends createZodDto(brandCreateRequestSchema) {}

export class DepartmentSummaryDto extends createZodDto(departmentSummarySchema) {}
export class DepartmentSummaryListDto extends createZodDto(departmentSummaryListSchema) {}
export class DepartmentCreateRequestDto extends createZodDto(departmentCreateRequestSchema) {}
export class DepartmentUpdateRequestDto extends createZodDto(departmentUpdateRequestSchema) {}
export class DepartmentReorderRequestDto extends createZodDto(departmentReorderRequestSchema) {}
export class DepartmentParamDto extends createZodDto(departmentParamSchema) {}

export class TeamListDto extends createZodDto(teamListSchema) {}
export class TeamCreateRequestDto extends createZodDto(teamCreateRequestSchema) {}
export class TeamUpdateRequestDto extends createZodDto(teamUpdateRequestSchema) {}
export class TeamParamDto extends createZodDto(teamParamSchema) {}
export class TeamMemberParamDto extends createZodDto(teamMemberParamSchema) {}
export class TeamMemberAddRequestDto extends createZodDto(teamMemberAddRequestSchema) {}
export class EligibleMemberListDto extends createZodDto(eligibleMemberListSchema) {}
