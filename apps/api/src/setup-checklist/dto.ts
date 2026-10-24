import { brandIdParamSchema, setupChecklistSchema } from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** Declared here, not in `@helpdock/schemas`, for the reason `tickets/dto.ts` gives. */
export class SetupChecklistDto extends createZodDto(setupChecklistSchema) {}
export class SetupChecklistParamDto extends createZodDto(brandIdParamSchema) {}
