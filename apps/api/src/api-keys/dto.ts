import {
  apiKeyCreatedSchema,
  apiKeyCreateRequestSchema,
  apiKeyListSchema,
  apiKeyParamSchema,
  apiKeySchema,
  brandIdParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The API key schemas as Nest DTOs, for the reason `routes/dto.ts` gives. */

export class ApiKeyDto extends createZodDto(apiKeySchema) {}
export class ApiKeyCreatedDto extends createZodDto(apiKeyCreatedSchema) {}
export class ApiKeyListDto extends createZodDto(apiKeyListSchema) {}
export class ApiKeyCreateRequestDto extends createZodDto(apiKeyCreateRequestSchema) {}
export class ApiKeyBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class ApiKeyParamDto extends createZodDto(apiKeyParamSchema) {}
