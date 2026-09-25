import {
  brandIdParamSchema,
  ticketViewCountListSchema,
  ticketViewCreateRequestSchema,
  ticketViewListSchema,
  ticketViewParamSchema,
  ticketViewReorderRequestSchema,
  ticketViewSchema,
  ticketViewUpdateRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The view schemas as Nest DTOs, declared here for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 */

export class TicketViewDto extends createZodDto(ticketViewSchema) {}
export class TicketViewListDto extends createZodDto(ticketViewListSchema) {}
export class TicketViewCountListDto extends createZodDto(ticketViewCountListSchema) {}

export class TicketViewCreateRequestDto extends createZodDto(ticketViewCreateRequestSchema) {}
export class TicketViewUpdateRequestDto extends createZodDto(ticketViewUpdateRequestSchema) {}
export class TicketViewReorderRequestDto extends createZodDto(ticketViewReorderRequestSchema) {}

export class ViewsBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class TicketViewParamDto extends createZodDto(ticketViewParamSchema) {}
