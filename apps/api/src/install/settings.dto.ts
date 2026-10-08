import {
  installAuthenticationSettingsSchema,
  installAuthenticationSettingsUpdateSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

export class InstallAuthenticationSettingsDto extends createZodDto(
  installAuthenticationSettingsSchema,
) {}
export class InstallAuthenticationSettingsUpdateDto extends createZodDto(
  installAuthenticationSettingsUpdateSchema,
) {}
