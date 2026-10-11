import {
  brandIdParamSchema,
  metaAccountCreateRequestSchema,
  metaAccountListSchema,
  metaAccountParamSchema,
  metaAccountSchema,
  metaAccountStatusResponseSchema,
  metaAccountUpdateRequestSchema,
  metaAppSchema,
  metaTokenTestRequestSchema,
  metaVerifyTokenRevealSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The Meta routes' DTOs (M10). Each deliverable that adds routes adds its
 * wrappers here, as the Telegram module's `dto.ts` grew: M10-02 has the App
 * card's two, M10-06 the ticket's, M10-07 the accounts'.
 */

export class MetaAppDto extends createZodDto(metaAppSchema) {}
export class MetaVerifyTokenRevealDto extends createZodDto(metaVerifyTokenRevealSchema) {}

/**
 * The accounts' routes (M10-07). The test and subscribe answers are
 * discriminated unions, which `createZodDto` cannot wrap, so the controller
 * parses those by hand, as `TelegramBotsController` does.
 */
export class MetaBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class MetaAccountParamDto extends createZodDto(metaAccountParamSchema) {}
export class MetaAccountDto extends createZodDto(metaAccountSchema) {}
export class MetaAccountListDto extends createZodDto(metaAccountListSchema) {}
export class MetaAccountCreateDto extends createZodDto(metaAccountCreateRequestSchema) {}
export class MetaAccountUpdateDto extends createZodDto(metaAccountUpdateRequestSchema) {}
export class MetaAccountStatusDto extends createZodDto(metaAccountStatusResponseSchema) {}
export class MetaTokenTestDto extends createZodDto(metaTokenTestRequestSchema) {}
