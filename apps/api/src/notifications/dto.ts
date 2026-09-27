import {
  brandIdParamSchema,
  notificationListQuerySchema,
  notificationListSchema,
  notificationParamSchema,
  notificationPreferencesUpdateSchema,
  notificationPreferencesViewSchema,
  pushSubscriptionCreateSchema,
  pushSubscriptionParamSchema,
  pushSubscriptionSchema,
  pushTestRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The notification schemas as Nest DTOs, declared here for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 */

export class NotificationListDto extends createZodDto(notificationListSchema) {}
export class NotificationListQueryDto extends createZodDto(notificationListQuerySchema) {}
export class NotificationBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class NotificationParamDto extends createZodDto(notificationParamSchema) {}
export class PushTestRequestDto extends createZodDto(pushTestRequestSchema) {}

export class NotificationPreferencesViewDto extends createZodDto(
  notificationPreferencesViewSchema,
) {}
export class NotificationPreferencesUpdateDto extends createZodDto(
  notificationPreferencesUpdateSchema,
) {}
export class PushSubscriptionCreateDto extends createZodDto(pushSubscriptionCreateSchema) {}
export class PushSubscriptionDto extends createZodDto(pushSubscriptionSchema) {}
export class PushSubscriptionParamDto extends createZodDto(pushSubscriptionParamSchema) {}
