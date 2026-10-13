import {
  ssoConnectionCreateSchema,
  ssoConnectionDetailSchema,
  ssoConnectionListSchema,
  ssoConnectionParamSchema,
  ssoConnectionSchema,
  ssoConnectionUpdateSchema,
  ssoMappingsSchema,
  ssoSettingsSchema,
  ssoSettingsUpdateSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

export class SsoCreateDto extends createZodDto(ssoConnectionCreateSchema) {}
export class SsoUpdateDto extends createZodDto(ssoConnectionUpdateSchema) {}
export class SsoConnectionDto extends createZodDto(ssoConnectionSchema) {}
export class SsoDetailDto extends createZodDto(ssoConnectionDetailSchema) {}
export class SsoListDto extends createZodDto(ssoConnectionListSchema) {}
export class SsoParamDto extends createZodDto(ssoConnectionParamSchema) {}
export class SsoMappingsDto extends createZodDto(ssoMappingsSchema) {}
export class SsoSettingsDto extends createZodDto(ssoSettingsSchema) {}
export class SsoSettingsUpdateDto extends createZodDto(ssoSettingsUpdateSchema) {}

import { oidcCallbackQuerySchema, oidcStartQuerySchema } from './oidc-contracts.js';
export class OidcStartQueryDto extends createZodDto(oidcStartQuerySchema) {}
export class OidcCallbackQueryDto extends createZodDto(oidcCallbackQuerySchema) {}
