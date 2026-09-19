import {
  brandIdParamSchema,
  brandListSchema,
  brandSchema,
  domainCheckResultSchema,
  healthSchema,
  meSchema,
  readinessSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The schemas of `@helpdock/schemas` as Nest DTOs. They are declared here and
 * not there because `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` and `apps/widget` too.
 *
 * Every handler names an output DTO with `@ZodSerializerDto`, so the response is
 * parsed on the way out and an internal field cannot leak by being returned
 * (ARCHITECTURE §6, step 5).
 */

export class HealthDto extends createZodDto(healthSchema) {}
export class ReadinessDto extends createZodDto(readinessSchema) {}
export class MeDto extends createZodDto(meSchema) {}
export class BrandDto extends createZodDto(brandSchema) {}
export class BrandListDto extends createZodDto(brandListSchema) {}
export class BrandIdParamDto extends createZodDto(brandIdParamSchema) {}
export class DomainCheckResultDto extends createZodDto(domainCheckResultSchema) {}
