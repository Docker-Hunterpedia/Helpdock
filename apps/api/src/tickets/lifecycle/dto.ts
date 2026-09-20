import {
  brandIdParamSchema,
  brandSettingsSchema,
  replyBehaviourUpdateRequestSchema,
  ticketStatusCreateRequestSchema,
  ticketStatusListSchema,
  ticketStatusParamSchema,
  ticketStatusReorderRequestSchema,
  ticketStatusSchema,
  ticketStatusUpdateRequestSchema,
  ticketStatusUsageSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The ticketing-settings schemas as Nest DTOs, declared here for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 */

export class TicketStatusDto extends createZodDto(ticketStatusSchema) {}
export class TicketStatusListDto extends createZodDto(ticketStatusListSchema) {}
export class TicketStatusUsageDto extends createZodDto(ticketStatusUsageSchema) {}
export class BrandSettingsDto extends createZodDto(brandSettingsSchema) {}

export class TicketStatusCreateRequestDto extends createZodDto(ticketStatusCreateRequestSchema) {}
export class TicketStatusUpdateRequestDto extends createZodDto(ticketStatusUpdateRequestSchema) {}
export class TicketStatusReorderRequestDto extends createZodDto(ticketStatusReorderRequestSchema) {}
export class ReplyBehaviourUpdateRequestDto extends createZodDto(
  replyBehaviourUpdateRequestSchema,
) {}

export class TicketingBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class TicketStatusParamDto extends createZodDto(ticketStatusParamSchema) {}
