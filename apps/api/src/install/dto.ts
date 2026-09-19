import {
  setupAdminRequestSchema,
  setupAdminResponseSchema,
  setupBrandRequestSchema,
  setupBrandResponseSchema,
  setupCompleteResponseSchema,
  setupSmtpResponseSchema,
  smtpTestRequestSchema,
  smtpTestResultSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The wizard's schemas as Nest DTOs, declared here for the same reason as
 * `routes/dto.ts`: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 *
 * `setupSmtpRequestSchema` has no DTO. It is a discriminated union — save or
 * skip — and `createZodDto` wraps an object schema, so the controller hands
 * that one to `ZodValidationPipe` directly, which accepts a schema as well as
 * a DTO.
 */

export class SetupAdminRequestDto extends createZodDto(setupAdminRequestSchema) {}
export class SetupAdminResponseDto extends createZodDto(setupAdminResponseSchema) {}
export class SetupBrandRequestDto extends createZodDto(setupBrandRequestSchema) {}
export class SetupBrandResponseDto extends createZodDto(setupBrandResponseSchema) {}
export class SetupSmtpResponseDto extends createZodDto(setupSmtpResponseSchema) {}
export class SmtpTestRequestDto extends createZodDto(smtpTestRequestSchema) {}
export class SmtpTestResultDto extends createZodDto(smtpTestResultSchema) {}
export class SetupCompleteResponseDto extends createZodDto(setupCompleteResponseSchema) {}
