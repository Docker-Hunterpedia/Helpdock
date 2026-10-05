import {
  brandIdParamSchema,
  telegramBotCreateRequestSchema,
  telegramBotListSchema,
  telegramBotParamSchema,
  telegramBotSchema,
  telegramBotStatusSchema,
  telegramBotUpdateRequestSchema,
  telegramDeliveryListSchema,
  telegramDeliveryParamSchema,
  telegramTicketParamSchema,
  telegramWebhookParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The Telegram routes' DTOs (M6-05). The test and webhook answers are
 * discriminated unions, which `createZodDto` cannot wrap, so the controller
 * parses those by hand, as `MailboxesController` does for Test IMAP.
 */

export class TelegramBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class TelegramBotParamDto extends createZodDto(telegramBotParamSchema) {}
export class TelegramBotDto extends createZodDto(telegramBotSchema) {}
export class TelegramBotListDto extends createZodDto(telegramBotListSchema) {}
export class TelegramBotCreateDto extends createZodDto(telegramBotCreateRequestSchema) {}
export class TelegramBotUpdateDto extends createZodDto(telegramBotUpdateRequestSchema) {}
export class TelegramBotStatusDto extends createZodDto(telegramBotStatusSchema) {}
export class TelegramWebhookParamDto extends createZodDto(telegramWebhookParamSchema) {}
export class TelegramTicketParamDto extends createZodDto(telegramTicketParamSchema) {}
export class TelegramDeliveryParamDto extends createZodDto(telegramDeliveryParamSchema) {}
export class TelegramDeliveryListDto extends createZodDto(telegramDeliveryListSchema) {}
