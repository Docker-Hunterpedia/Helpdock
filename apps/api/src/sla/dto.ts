import {
  brandIdParamSchema,
  brandSettingsSchema,
  businessHoursOverviewSchema,
  businessHoursUpdateRequestSchema,
  holidayCreateRequestSchema,
  holidayParamSchema,
  holidaySchema,
  slaPolicyCreateRequestSchema,
  slaPolicyListSchema,
  slaPolicyParamSchema,
  slaPolicyReorderRequestSchema,
  slaPolicySchema,
  slaPolicyUpdateRequestSchema,
  slaSettingsUpdateRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The M3-01 and M3-02 schemas as Nest DTOs, declared here for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 */

export class SlaBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class HolidayParamDto extends createZodDto(holidayParamSchema) {}
export class SlaPolicyParamDto extends createZodDto(slaPolicyParamSchema) {}

export class BusinessHoursOverviewDto extends createZodDto(businessHoursOverviewSchema) {}
export class BusinessHoursUpdateRequestDto extends createZodDto(businessHoursUpdateRequestSchema) {}
export class HolidayDto extends createZodDto(holidaySchema) {}
export class HolidayCreateRequestDto extends createZodDto(holidayCreateRequestSchema) {}

export class SlaPolicyDto extends createZodDto(slaPolicySchema) {}
export class SlaPolicyListDto extends createZodDto(slaPolicyListSchema) {}
export class SlaPolicyCreateRequestDto extends createZodDto(slaPolicyCreateRequestSchema) {}
export class SlaPolicyUpdateRequestDto extends createZodDto(slaPolicyUpdateRequestSchema) {}
export class SlaPolicyReorderRequestDto extends createZodDto(slaPolicyReorderRequestSchema) {}
export class SlaSettingsUpdateRequestDto extends createZodDto(slaSettingsUpdateRequestSchema) {}
export class SlaBrandSettingsDto extends createZodDto(brandSettingsSchema) {}
