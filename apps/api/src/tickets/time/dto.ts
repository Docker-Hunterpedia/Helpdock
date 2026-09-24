import {
  timeEntryCreateRequestSchema,
  timeEntryListSchema,
  timeEntryParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The time-entry schemas as Nest DTOs, for the reason `tickets/dto.ts` gives. */

export class TimeEntryListDto extends createZodDto(timeEntryListSchema) {}
export class TimeEntryCreateRequestDto extends createZodDto(timeEntryCreateRequestSchema) {}
export class TimeEntryParamDto extends createZodDto(timeEntryParamSchema) {}
