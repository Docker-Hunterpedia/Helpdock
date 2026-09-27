import {
  autoRepliesSchema,
  brandIdParamSchema,
  emailOutgoingSettingsSchema,
  emailSendersSchema,
  emailSignatureSchema,
  failedSendListSchema,
  failedSendParamSchema,
  failedSendRetryResultSchema,
  outgoingSmtpTestResultSchema,
  outgoingSmtpUpdateSchema,
  ticketEmailContextSchema,
  ticketMessageDeliveryParamSchema,
  ticketParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The email schemas as Nest DTOs, for the reason `brands/dto.ts` gives. */
export class EmailBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class EmailOutgoingSettingsDto extends createZodDto(emailOutgoingSettingsSchema) {}
export class OutgoingSmtpUpdateDto extends createZodDto(outgoingSmtpUpdateSchema) {}
export class OutgoingSmtpTestResultDto extends createZodDto(outgoingSmtpTestResultSchema) {}
export class EmailSendersDto extends createZodDto(emailSendersSchema) {}
export class AutoRepliesDto extends createZodDto(autoRepliesSchema) {}
export class FailedSendListDto extends createZodDto(failedSendListSchema) {}
export class FailedSendParamDto extends createZodDto(failedSendParamSchema) {}
export class FailedSendRetryResultDto extends createZodDto(failedSendRetryResultSchema) {}
export class EmailSignatureDto extends createZodDto(emailSignatureSchema) {}
export class TicketEmailParamDto extends createZodDto(ticketParamSchema) {}
export class TicketEmailContextDto extends createZodDto(ticketEmailContextSchema) {}
export class TicketMessageDeliveryParamDto extends createZodDto(ticketMessageDeliveryParamSchema) {}
