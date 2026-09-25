import {
  brandIdParamSchema,
  customFieldCreateRequestSchema,
  customFieldDefListSchema,
  customFieldDefSchema,
  customFieldParamSchema,
  customFieldQuerySchema,
  customFieldReorderRequestSchema,
  customFieldUpdateRequestSchema,
  customFieldUsageSchema,
  tagCreateRequestSchema,
  tagListSchema,
  tagParamSchema,
  tagReorderRequestSchema,
  tagSummarySchema,
  tagUpdateRequestSchema,
  tagUsageSchema,
  ticketParamSchema,
  ticketTagListSchema,
  ticketTagsRequestSchema,
  ticketTemplateCreateRequestSchema,
  ticketTemplateListSchema,
  ticketTemplateParamSchema,
  ticketTemplatePreviewQuerySchema,
  ticketTemplatePreviewSchema,
  ticketTemplateSchema,
  ticketTemplateUpdateRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The M1-06 schemas as Nest DTOs, declared here for the reason `routes/dto.ts`
 * gives: `createZodDto` pulls in `@nestjs/common`, and `@helpdock/schemas` is
 * imported by `apps/admin` too.
 *
 * Every handler names an output DTO with `@ZodSerializerDto` and names its
 * input schema on the parameter, which `pnpm check:validation` enforces.
 */

export class TicketingBrandParamDto extends createZodDto(brandIdParamSchema) {}

// ------------------------------------------------------------------- tags

export class TagSummaryDto extends createZodDto(tagSummarySchema) {}
export class TagListDto extends createZodDto(tagListSchema) {}
export class TagUsageDto extends createZodDto(tagUsageSchema) {}
export class TagParamDto extends createZodDto(tagParamSchema) {}
export class TagCreateRequestDto extends createZodDto(tagCreateRequestSchema) {}
export class TagUpdateRequestDto extends createZodDto(tagUpdateRequestSchema) {}
export class TagReorderRequestDto extends createZodDto(tagReorderRequestSchema) {}

export class TicketTagsRequestDto extends createZodDto(ticketTagsRequestSchema) {}
export class TicketTagListDto extends createZodDto(ticketTagListSchema) {}
export class TicketTagParamDto extends createZodDto(ticketParamSchema) {}

// ---------------------------------------------------------- custom fields

export class CustomFieldDefDto extends createZodDto(customFieldDefSchema) {}
export class CustomFieldDefListDto extends createZodDto(customFieldDefListSchema) {}
export class CustomFieldUsageDto extends createZodDto(customFieldUsageSchema) {}
export class CustomFieldParamDto extends createZodDto(customFieldParamSchema) {}
export class CustomFieldQueryDto extends createZodDto(customFieldQuerySchema) {}
export class CustomFieldCreateRequestDto extends createZodDto(customFieldCreateRequestSchema) {}
export class CustomFieldUpdateRequestDto extends createZodDto(customFieldUpdateRequestSchema) {}
export class CustomFieldReorderRequestDto extends createZodDto(customFieldReorderRequestSchema) {}

// --------------------------------------------------------------- templates

export class TicketTemplateDto extends createZodDto(ticketTemplateSchema) {}
export class TicketTemplateListDto extends createZodDto(ticketTemplateListSchema) {}
export class TicketTemplatePreviewDto extends createZodDto(ticketTemplatePreviewSchema) {}
export class TicketTemplateParamDto extends createZodDto(ticketTemplateParamSchema) {}
export class TicketTemplatePreviewQueryDto extends createZodDto(ticketTemplatePreviewQuerySchema) {}
export class TicketTemplateCreateRequestDto extends createZodDto(
  ticketTemplateCreateRequestSchema,
) {}
export class TicketTemplateUpdateRequestDto extends createZodDto(
  ticketTemplateUpdateRequestSchema,
) {}
