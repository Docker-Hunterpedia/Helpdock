import {
  brandIdParamSchema,
  knowledgeBrowseQuerySchema,
  knowledgeBrowseSchema,
  knowledgeFilePresignResponseSchema,
  knowledgeFilePresignSchema,
  knowledgeLogQuerySchema,
  knowledgeLogSchema,
  knowledgeOAuthCallbackQuerySchema,
  knowledgeOAuthProviderParamSchema,
  knowledgeOAuthStartSchema,
  knowledgeSourceListSchema,
  knowledgeSourceParamSchema,
  knowledgeSourceUpdateSchema,
  knowledgeSourceViewSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The knowledge schemas as Nest DTOs, for the reason `brands/dto.ts` gives. */
export class KnowledgeBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class KnowledgeSourceParamDto extends createZodDto(knowledgeSourceParamSchema) {}
export class KnowledgeOAuthProviderParamDto extends createZodDto(
  knowledgeOAuthProviderParamSchema,
) {}
export class KnowledgeSourceListDto extends createZodDto(knowledgeSourceListSchema) {}
export class KnowledgeSourceViewDto extends createZodDto(knowledgeSourceViewSchema) {}
export class KnowledgeSourceUpdateDto extends createZodDto(knowledgeSourceUpdateSchema) {}
export class KnowledgeFilePresignDto extends createZodDto(knowledgeFilePresignSchema) {}
export class KnowledgeFilePresignResponseDto extends createZodDto(
  knowledgeFilePresignResponseSchema,
) {}
export class KnowledgeLogQueryDto extends createZodDto(knowledgeLogQuerySchema) {}
export class KnowledgeLogDto extends createZodDto(knowledgeLogSchema) {}
export class KnowledgeBrowseQueryDto extends createZodDto(knowledgeBrowseQuerySchema) {}
export class KnowledgeBrowseDto extends createZodDto(knowledgeBrowseSchema) {}
export class KnowledgeOAuthStartDto extends createZodDto(knowledgeOAuthStartSchema) {}
export class KnowledgeOAuthCallbackQueryDto extends createZodDto(
  knowledgeOAuthCallbackQuerySchema,
) {}
