import {
  authMethodsSchema,
  authSessionResponseSchema,
  exchangeRequestSchema,
  magicLinkRequestSchema,
  magicLinkTokenParamSchema,
  oauthCallbackQuerySchema,
  oauthProviderParamSchema,
  passwordForgotRequestSchema,
  passwordResetRequestSchema,
  recoveryCodeRequestSchema,
  recoveryCodesSchema,
  sessionSchema,
  signInRequestSchema,
  totpConfirmRequestSchema,
  totpEnrolmentSchema,
  totpRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The auth schemas as Nest DTOs. They are declared here rather than in
 * `@helpdock/schemas` because `createZodDto` pulls in `@nestjs/common`, and
 * that package is imported by `apps/admin` too (see `routes/dto.ts`, which does
 * the same for everything else).
 */

export class SignInRequestDto extends createZodDto(signInRequestSchema) {}
/**
 * `signInResponseSchema` has no DTO of its own: `createZodDto` wraps an object
 * schema and the sign-in answer is a discriminated union. The controller parses
 * it through the schema by hand instead, so the guarantee `@ZodSerializerDto`
 * gives every other route — nothing leaves that the schema did not declare —
 * still holds.
 */
export class MagicLinkRequestDto extends createZodDto(magicLinkRequestSchema) {}
export class MagicLinkTokenParamDto extends createZodDto(magicLinkTokenParamSchema) {}
export class OauthProviderParamDto extends createZodDto(oauthProviderParamSchema) {}
export class OauthCallbackQueryDto extends createZodDto(oauthCallbackQuerySchema) {}
export class TotpRequestDto extends createZodDto(totpRequestSchema) {}
export class TotpConfirmRequestDto extends createZodDto(totpConfirmRequestSchema) {}
export class RecoveryCodeRequestDto extends createZodDto(recoveryCodeRequestSchema) {}
export class ExchangeRequestDto extends createZodDto(exchangeRequestSchema) {}
export class PasswordForgotRequestDto extends createZodDto(passwordForgotRequestSchema) {}
export class PasswordResetRequestDto extends createZodDto(passwordResetRequestSchema) {}
export class AuthSessionResponseDto extends createZodDto(authSessionResponseSchema) {}
export class SessionDto extends createZodDto(sessionSchema) {}
export class AuthMethodsDto extends createZodDto(authMethodsSchema) {}
export class TotpEnrolmentDto extends createZodDto(totpEnrolmentSchema) {}
export class RecoveryCodesDto extends createZodDto(recoveryCodesSchema) {}
