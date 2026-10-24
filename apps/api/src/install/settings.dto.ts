import {
  installAuthenticationSettingsSchema,
  installAuthenticationSettingsUpdateSchema,
  smtpSettingsSchema,
  smtpSettingsTestRequestSchema,
  smtpSettingsUpdateSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

export class InstallAuthenticationSettingsDto extends createZodDto(
  installAuthenticationSettingsSchema,
) {}
export class InstallAuthenticationSettingsUpdateDto extends createZodDto(
  installAuthenticationSettingsUpdateSchema,
) {}

/** The System page's Outgoing email card (#369). */
export class SmtpSettingsDto extends createZodDto(smtpSettingsSchema) {}
export class SmtpSettingsUpdateDto extends createZodDto(smtpSettingsUpdateSchema) {}
export class SmtpSettingsTestRequestDto extends createZodDto(smtpSettingsTestRequestSchema) {}
