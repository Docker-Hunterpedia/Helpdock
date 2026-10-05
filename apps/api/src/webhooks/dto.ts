import {
  brandIdParamSchema,
  webhookCreateRequestSchema,
  webhookDeliveryDetailSchema,
  webhookDeliveryListSchema,
  webhookDeliveryParamSchema,
  webhookDeliveryQuerySchema,
  webhookDeliverySchema,
  webhookListSchema,
  webhookOverviewListSchema,
  webhookParamSchema,
  webhookSchema,
  webhookUpdateRequestSchema,
  webhookWithSecretSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The webhook schemas as Nest DTOs, for the reason `routes/dto.ts` gives. */

export class WebhookDto extends createZodDto(webhookSchema) {}
export class WebhookWithSecretDto extends createZodDto(webhookWithSecretSchema) {}
export class WebhookListDto extends createZodDto(webhookListSchema) {}
export class WebhookDeliveryDto extends createZodDto(webhookDeliverySchema) {}
export class WebhookDeliveryDetailDto extends createZodDto(webhookDeliveryDetailSchema) {}
export class WebhookOverviewListDto extends createZodDto(webhookOverviewListSchema) {}
export class WebhookDeliveryListDto extends createZodDto(webhookDeliveryListSchema) {}
export class WebhookCreateRequestDto extends createZodDto(webhookCreateRequestSchema) {}
export class WebhookUpdateRequestDto extends createZodDto(webhookUpdateRequestSchema) {}
export class WebhookDeliveryQueryDto extends createZodDto(webhookDeliveryQuerySchema) {}
export class WebhookBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class WebhookParamDto extends createZodDto(webhookParamSchema) {}
export class WebhookDeliveryParamDto extends createZodDto(webhookDeliveryParamSchema) {}
