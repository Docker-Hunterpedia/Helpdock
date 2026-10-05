import {
  aiDefaultModelUpdateSchema,
  aiModelListSchema,
  aiProviderParamSchema,
  aiProvidersOverviewSchema,
  aiProviderUpsertSchema,
  aiProviderViewSchema,
  brandAiPromptUpdateSchema,
  brandAiSettingsSchema,
  brandAiSettingsUpdateSchema,
  brandIdParamSchema,
  embeddingSettingsUpdateSchema,
  embeddingSettingsViewSchema,
  ticketAiCallsParamSchema,
  ticketAiCallsSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The AI schemas as Nest DTOs, for the reason `brands/dto.ts` gives. */
export class AiProviderParamDto extends createZodDto(aiProviderParamSchema) {}
export class AiProvidersOverviewDto extends createZodDto(aiProvidersOverviewSchema) {}
export class AiProviderUpsertDto extends createZodDto(aiProviderUpsertSchema) {}
export class AiProviderViewDto extends createZodDto(aiProviderViewSchema) {}
export class AiModelListDto extends createZodDto(aiModelListSchema) {}
export class AiDefaultModelUpdateDto extends createZodDto(aiDefaultModelUpdateSchema) {}
export class EmbeddingSettingsViewDto extends createZodDto(embeddingSettingsViewSchema) {}
export class EmbeddingSettingsUpdateDto extends createZodDto(embeddingSettingsUpdateSchema) {}
export class AiBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class BrandAiSettingsDto extends createZodDto(brandAiSettingsSchema) {}
export class BrandAiSettingsUpdateDto extends createZodDto(brandAiSettingsUpdateSchema) {}
export class BrandAiPromptUpdateDto extends createZodDto(brandAiPromptUpdateSchema) {}
export class TicketAiCallsParamDto extends createZodDto(ticketAiCallsParamSchema) {}
export class TicketAiCallsDto extends createZodDto(ticketAiCallsSchema) {}
