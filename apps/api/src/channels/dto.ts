import {
  brandIdParamSchema,
  inboundParseSecretSchema,
  inboundParseSettingsSchema,
  mailboxListSchema,
  mailboxParamSchema,
  mailboxSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The Channels routes' DTOs (M2-08). The create, update and test bodies are
 * discriminated unions, which `createZodDto` cannot wrap, so the controller
 * names those schemas in its `ZodValidationPipe` directly and parses the one
 * union response (`imapTestResultSchema`) by hand, as `CsatController` does.
 */

export class ChannelsBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class MailboxParamDto extends createZodDto(mailboxParamSchema) {}
export class MailboxDto extends createZodDto(mailboxSchema) {}
export class MailboxListDto extends createZodDto(mailboxListSchema) {}
export class InboundParseSettingsDto extends createZodDto(inboundParseSettingsSchema) {}
export class InboundParseSecretDto extends createZodDto(inboundParseSecretSchema) {}
