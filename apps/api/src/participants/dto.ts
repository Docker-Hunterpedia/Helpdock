import {
  ticketCcRequestSchema,
  ticketParamSchema,
  ticketParticipantListSchema,
  ticketParticipantParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The participant schemas as Nest DTOs, for the reason `contacts/dto.ts` gives. */
export class TicketParticipantListDto extends createZodDto(ticketParticipantListSchema) {}
export class TicketCcRequestDto extends createZodDto(ticketCcRequestSchema) {}
export class TicketParamDto extends createZodDto(ticketParamSchema) {}
export class TicketParticipantParamDto extends createZodDto(ticketParticipantParamSchema) {}
