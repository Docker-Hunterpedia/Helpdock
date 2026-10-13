import {
  ssoCertificateDetailsSchema,
  ssoCertificatesSchema,
  ssoConfigurationSchema,
  ssoConnectionCreateSchema,
  ssoConnectionDetailSchema,
  ssoConnectionListSchema,
  ssoConnectionParamSchema,
  ssoConnectionSchema,
  ssoConnectionUpdateSchema,
  ssoDiscoveryRequestSchema,
  ssoDiscoveryResponseSchema,
  ssoMappingsSchema,
  ssoSettingsSchema,
  ssoSettingsUpdateSchema,
  ssoTargetsSchema,
  ssoTestKeySchema,
  ssoTestResultSchema,
  ssoTestStartSchema,
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

import { samlAcsSchema, samlCompleteQuerySchema } from './saml-contracts.js';
export class SamlAcsDto extends createZodDto(samlAcsSchema) {}
export class SamlCompleteQueryDto extends createZodDto(samlCompleteQuerySchema) {}

export class SsoDiscoveryRequestDto extends createZodDto(ssoDiscoveryRequestSchema) {}
export class SsoDiscoveryResponseDto extends createZodDto(ssoDiscoveryResponseSchema) {}

export class SsoTestStartDto extends createZodDto(ssoTestStartSchema) {}
export class SsoTestResultDto extends createZodDto(ssoTestResultSchema) {}
export class SsoTestKeyDto extends createZodDto(ssoTestKeySchema) {}

export class SsoTargetsDto extends createZodDto(ssoTargetsSchema) {}

export class SsoConfigurationDto extends createZodDto(ssoConfigurationSchema) {}

export class SsoCertificatesDto extends createZodDto(ssoCertificatesSchema) {}
export class SsoCertificateDetailsDto extends createZodDto(ssoCertificateDetailsSchema) {}
