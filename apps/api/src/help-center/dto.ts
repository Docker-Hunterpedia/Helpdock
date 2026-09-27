import {
  brandIdParamSchema,
  hcArticleCreateRequestSchema,
  hcArticleParamSchema,
  hcArticleSchema,
  hcArticleUpdateRequestSchema,
  hcCategoryCreateRequestSchema,
  hcCategoryParamSchema,
  hcCategorySchema,
  hcCategoryUpdateRequestSchema,
  hcMediaParamSchema,
  hcMediaPresignRequestSchema,
  hcMediaPresignResponseSchema,
  hcMediaSchema,
  hcReorderRequestSchema,
  hcSectionCreateRequestSchema,
  hcSectionParamSchema,
  hcSectionSchema,
  hcSectionUpdateRequestSchema,
  hcSettingsSchema,
  hcSettingsUpdateRequestSchema,
  hcStructureSchema,
  hcVersionParamSchema,
  hcVersionSaveRequestSchema,
  hcVersionStatusRequestSchema,
  hcVersionVisibilityRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The help center schemas as Nest DTOs, declared here for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 */

export class HcBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class HcCategoryParamDto extends createZodDto(hcCategoryParamSchema) {}
export class HcSectionParamDto extends createZodDto(hcSectionParamSchema) {}
export class HcArticleParamDto extends createZodDto(hcArticleParamSchema) {}
export class HcVersionParamDto extends createZodDto(hcVersionParamSchema) {}
export class HcMediaParamDto extends createZodDto(hcMediaParamSchema) {}

export class HcStructureDto extends createZodDto(hcStructureSchema) {}
export class HcCategoryDto extends createZodDto(hcCategorySchema) {}
export class HcCategoryCreateRequestDto extends createZodDto(hcCategoryCreateRequestSchema) {}
export class HcCategoryUpdateRequestDto extends createZodDto(hcCategoryUpdateRequestSchema) {}
export class HcSectionDto extends createZodDto(hcSectionSchema) {}
export class HcSectionCreateRequestDto extends createZodDto(hcSectionCreateRequestSchema) {}
export class HcSectionUpdateRequestDto extends createZodDto(hcSectionUpdateRequestSchema) {}
export class HcReorderRequestDto extends createZodDto(hcReorderRequestSchema) {}

export class HcArticleDto extends createZodDto(hcArticleSchema) {}
export class HcArticleCreateRequestDto extends createZodDto(hcArticleCreateRequestSchema) {}
export class HcArticleUpdateRequestDto extends createZodDto(hcArticleUpdateRequestSchema) {}
export class HcVersionSaveRequestDto extends createZodDto(hcVersionSaveRequestSchema) {}
export class HcVersionStatusRequestDto extends createZodDto(hcVersionStatusRequestSchema) {}
export class HcVersionVisibilityRequestDto extends createZodDto(hcVersionVisibilityRequestSchema) {}

export class HcSettingsDto extends createZodDto(hcSettingsSchema) {}
export class HcSettingsUpdateRequestDto extends createZodDto(hcSettingsUpdateRequestSchema) {}

export class HcMediaDto extends createZodDto(hcMediaSchema) {}
export class HcMediaPresignRequestDto extends createZodDto(hcMediaPresignRequestSchema) {}
export class HcMediaPresignResponseDto extends createZodDto(hcMediaPresignResponseSchema) {}
