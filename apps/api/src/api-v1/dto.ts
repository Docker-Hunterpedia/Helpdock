import {
  ticketListSchema,
  ticketMessagePageSchema,
  ticketMessageSchema,
  ticketUpdateRequestSchema,
  v1ArticleParamSchema,
  v1ArticleQuerySchema,
  v1ArticleSchema,
  v1ArticleSearchQuerySchema,
  v1ArticleSearchSchema,
  v1ContactListSchema,
  v1ContactParamSchema,
  v1ContactSchema,
  v1ContactSearchQuerySchema,
  v1ContactUpsertRequestSchema,
  v1ContactUpsertSchema,
  v1MessageCreateRequestSchema,
  v1MessagePageQuerySchema,
  v1TicketCreateRequestSchema,
  v1TicketDetailSchema,
  v1TicketListQuerySchema,
  v1TicketParamSchema,
  v1TicketSchema,
  v1WebhookDeliveryParamSchema,
  v1WebhookParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The public API's schemas as Nest DTOs, for the reason `routes/dto.ts` gives.
 * The webhook routes reuse `webhooks/dto.ts` for their bodies and answers.
 */

export class V1TicketDto extends createZodDto(v1TicketSchema) {}
export class V1TicketListDto extends createZodDto(ticketListSchema) {}
export class V1TicketDetailDto extends createZodDto(v1TicketDetailSchema) {}
export class V1TicketMessageDto extends createZodDto(ticketMessageSchema) {}
export class V1TicketMessagePageDto extends createZodDto(ticketMessagePageSchema) {}
export class V1TicketListQueryDto extends createZodDto(v1TicketListQuerySchema) {}
export class V1TicketCreateRequestDto extends createZodDto(v1TicketCreateRequestSchema) {}
export class V1TicketUpdateRequestDto extends createZodDto(ticketUpdateRequestSchema) {}
export class V1MessageCreateRequestDto extends createZodDto(v1MessageCreateRequestSchema) {}
export class V1MessagePageQueryDto extends createZodDto(v1MessagePageQuerySchema) {}
export class V1TicketParamDto extends createZodDto(v1TicketParamSchema) {}

export class V1ContactDto extends createZodDto(v1ContactSchema) {}
export class V1ContactListDto extends createZodDto(v1ContactListSchema) {}
export class V1ContactUpsertDto extends createZodDto(v1ContactUpsertSchema) {}
export class V1ContactUpsertRequestDto extends createZodDto(v1ContactUpsertRequestSchema) {}
export class V1ContactSearchQueryDto extends createZodDto(v1ContactSearchQuerySchema) {}
export class V1ContactParamDto extends createZodDto(v1ContactParamSchema) {}

export class V1ArticleDto extends createZodDto(v1ArticleSchema) {}
export class V1ArticleSearchDto extends createZodDto(v1ArticleSearchSchema) {}
export class V1ArticleSearchQueryDto extends createZodDto(v1ArticleSearchQuerySchema) {}
export class V1ArticleParamDto extends createZodDto(v1ArticleParamSchema) {}
export class V1ArticleQueryDto extends createZodDto(v1ArticleQuerySchema) {}

export class V1WebhookParamDto extends createZodDto(v1WebhookParamSchema) {}
export class V1WebhookDeliveryParamDto extends createZodDto(v1WebhookDeliveryParamSchema) {}
