import {
  brandIdParamSchema,
  customDomainCreateRequestSchema,
  customDomainListSchema,
  customDomainParamSchema,
  customDomainSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * Brand › Domains' DTOs (M5-07). The update body has a `refine`, which
 * `createZodDto` cannot wrap, so the controller names that schema in its
 * `ZodValidationPipe` directly, as `MailboxesController` does.
 */

export class DomainsBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class DomainParamDto extends createZodDto(customDomainParamSchema) {}
export class DomainCreateRequestDto extends createZodDto(customDomainCreateRequestSchema) {}
export class DomainDto extends createZodDto(customDomainSchema) {}
export class DomainListDto extends createZodDto(customDomainListSchema) {}
