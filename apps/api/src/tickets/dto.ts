import {
  brandIdParamSchema,
  bulkOperationParamSchema,
  bulkRequestSchema,
  bulkResponseSchema,
  bulkUndoResponseSchema,
  messageCreateRequestSchema,
  messagePageQuerySchema,
  snoozePresetsQuerySchema,
  snoozePresetsSchema,
  ticketActivityListSchema,
  ticketActivityQuerySchema,
  ticketCreateRequestSchema,
  ticketDetailSchema,
  ticketListQuerySchema,
  ticketListSchema,
  ticketMessagePageSchema,
  ticketMessageSchema,
  ticketParamSchema,
  ticketRoutingSchema,
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
export class TicketActivityQueryDto extends createZodDto(ticketActivityQuerySchema) {}

export class TicketListQueryDto extends createZodDto(ticketListQuerySchema) {}
export class MessagePageQueryDto extends createZodDto(messagePageQuerySchema) {}
export class TicketCreateRequestDto extends createZodDto(ticketCreateRequestSchema) {}
export class TicketUpdateRequestDto extends createZodDto(ticketUpdateRequestSchema) {}
export class MessageCreateRequestDto extends createZodDto(messageCreateRequestSchema) {}

export class TicketBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class TicketParamDto extends createZodDto(ticketParamSchema) {}
/** M14-08's routing trail. */
export class TicketRoutingDto extends createZodDto(ticketRoutingSchema) {}
/** M14-02's Snooze menu. */
export class SnoozePresetsDto extends createZodDto(snoozePresetsSchema) {}
export class SnoozePresetsQueryDto extends createZodDto(snoozePresetsQuerySchema) {}

export class BulkRequestDto extends createZodDto(bulkRequestSchema) {}
export class BulkResponseDto extends createZodDto(bulkResponseSchema) {}
export class BulkUndoResponseDto extends createZodDto(bulkUndoResponseSchema) {}
export class BulkOperationParamDto extends createZodDto(bulkOperationParamSchema) {}
