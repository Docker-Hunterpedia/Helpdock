import {
  webFormBrandParamSchema,
  webFormSettingsSchema,
  webFormSettingsUpdateSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The web form schemas as Nest DTOs, for the reason `brands/dto.ts` gives. */
export class WebFormBrandParamDto extends createZodDto(webFormBrandParamSchema) {}
export class WebFormSettingsDto extends createZodDto(webFormSettingsSchema) {}
export class WebFormSettingsUpdateDto extends createZodDto(webFormSettingsUpdateSchema) {}
