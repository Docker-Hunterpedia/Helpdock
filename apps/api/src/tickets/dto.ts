import {
  brandIdParamSchema,
  messageCreateRequestSchema,
  messagePageQuerySchema,
  ticketActivityListSchema,
  ticketCreateRequestSchema,
  ticketDetailSchema,
  ticketListQuerySchema,
  ticketListSchema,
  ticketMessagePageSchema,
  ticketMessageSchema,
  ticketParamSchema,
  ticketSchema,
  ticketStatusListSchema,
  ticketUpdateRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The ticket schemas as Nest DTOs, declared here for the reason `routes/dto.ts`
 * gives: `createZodDto` pulls in `@nestjs/common`, and `@helpdock/schemas` is
 * imported by `apps/admin` too.
 *
 * Every handler names an output DTO with `@ZodSerializerDto`, so a column a
 * later milestone adds to `tickets` or `ticket_messages` cannot leak by being
 * returned (ARCHITECTURE §6, step 5), and names its input schema on the
 * parameter, which `pnpm check:validation` enforces.
 */

export class TicketDto extends createZodDto(ticketSchema) {}
export class TicketListDto extends createZodDto(ticketListSchema) {}
export class TicketDetailDto extends createZodDto(ticketDetailSchema) {}
export class TicketStatusListDto extends createZodDto(ticketStatusListSchema) {}
export class TicketMessageDto extends createZodDto(ticketMessageSchema) {}
export class TicketMessagePageDto extends createZodDto(ticketMessagePageSchema) {}
export class TicketActivityListDto extends createZodDto(ticketActivityListSchema) {}

export class TicketListQueryDto extends createZodDto(ticketListQuerySchema) {}
export class MessagePageQueryDto extends createZodDto(messagePageQuerySchema) {}
export class TicketCreateRequestDto extends createZodDto(ticketCreateRequestSchema) {}
export class TicketUpdateRequestDto extends createZodDto(ticketUpdateRequestSchema) {}
export class MessageCreateRequestDto extends createZodDto(messageCreateRequestSchema) {}

export class TicketBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class TicketParamDto extends createZodDto(ticketParamSchema) {}
