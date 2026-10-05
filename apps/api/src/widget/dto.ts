import {
  attachmentDownloadQuerySchema,
  attachmentPresignRequestSchema,
  attachmentPresignResponseSchema,
  brandIdParamSchema,
  contentPolicySchema,
  widgetAccessUpdateSchema,
  widgetAppearanceSchema,
  widgetAttachmentParamSchema,
  widgetAttachmentSchema,
  widgetAvailabilitySchema,
  widgetBrandParamSchema,
  widgetConfigQuerySchema,
  widgetConfigSchema,
  widgetConversationListSchema,
  widgetConversationParamSchema,
  widgetConversationSchema,
  widgetConversationSettingsSchema,
  widgetFeedbackRequestSchema,
  widgetMessagePageSchema,
  widgetMessageParamSchema,
  widgetMessageSchema,
  widgetMessagesQuerySchema,
  widgetQueueSchema,
  widgetReadRequestSchema,
  widgetSendRequestSchema,
  widgetSendResponseSchema,
  widgetSessionRequestSchema,
  widgetSessionSchema,
  widgetSettingsSchema,
  widgetSignedIdentitySchema,
  widgetSigningSecretSchema,
  widgetStartRequestSchema,
  widgetStartResponseSchema,
  widgetStreamQuerySchema,
  widgetTranscriptRequestSchema,
  widgetTypingRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { widgetFileParamSchema } from './widget-bundle.js';

/** The widget schemas as Nest DTOs, for the reason `brands/dto.ts` gives. */

// ------------------------------------------------------------ admin (M4-06)
export class WidgetAdminParamDto extends createZodDto(brandIdParamSchema) {}
export class WidgetSettingsDto extends createZodDto(widgetSettingsSchema) {}
export class WidgetAppearanceDto extends createZodDto(widgetAppearanceSchema) {}
export class WidgetConversationSettingsDto extends createZodDto(widgetConversationSettingsSchema) {}
export class WidgetContentPolicyDto extends createZodDto(contentPolicySchema) {}
export class WidgetAccessUpdateDto extends createZodDto(widgetAccessUpdateSchema) {}
export class WidgetSignedIdentityDto extends createZodDto(widgetSignedIdentitySchema) {}
export class WidgetSigningSecretDto extends createZodDto(widgetSigningSecretSchema) {}

// ------------------------------------------------------------ bundle (M4-01)
export class WidgetFileParamDto extends createZodDto(widgetFileParamSchema) {}

// ------------------------------------------------------- visitor (M4-02..04)
export class WidgetBrandParamDto extends createZodDto(widgetBrandParamSchema) {}
export class WidgetConversationParamDto extends createZodDto(widgetConversationParamSchema) {}
export class WidgetAttachmentParamDto extends createZodDto(widgetAttachmentParamSchema) {}
export class WidgetConfigDto extends createZodDto(widgetConfigSchema) {}
export class WidgetConfigQueryDto extends createZodDto(widgetConfigQuerySchema) {}
export class WidgetAvailabilityDto extends createZodDto(widgetAvailabilitySchema) {}
export class WidgetSessionRequestDto extends createZodDto(widgetSessionRequestSchema) {}
export class WidgetSessionDto extends createZodDto(widgetSessionSchema) {}
export class WidgetConversationDto extends createZodDto(widgetConversationSchema) {}
export class WidgetConversationListDto extends createZodDto(widgetConversationListSchema) {}
export class WidgetStartRequestDto extends createZodDto(widgetStartRequestSchema) {}
export class WidgetStartResponseDto extends createZodDto(widgetStartResponseSchema) {}
export class WidgetSendRequestDto extends createZodDto(widgetSendRequestSchema) {}
export class WidgetSendResponseDto extends createZodDto(widgetSendResponseSchema) {}
export class WidgetMessagesQueryDto extends createZodDto(widgetMessagesQuerySchema) {}
export class WidgetMessagePageDto extends createZodDto(widgetMessagePageSchema) {}
export class WidgetReadRequestDto extends createZodDto(widgetReadRequestSchema) {}
export class WidgetTypingRequestDto extends createZodDto(widgetTypingRequestSchema) {}
export class WidgetMessageParamDto extends createZodDto(widgetMessageParamSchema) {}
export class WidgetMessageDto extends createZodDto(widgetMessageSchema) {}
export class WidgetFeedbackRequestDto extends createZodDto(widgetFeedbackRequestSchema) {}
export class WidgetTranscriptRequestDto extends createZodDto(widgetTranscriptRequestSchema) {}
export class WidgetQueueDto extends createZodDto(widgetQueueSchema) {}
export class WidgetStreamQueryDto extends createZodDto(widgetStreamQuerySchema) {}
export class WidgetUploadRequestDto extends createZodDto(attachmentPresignRequestSchema) {}
export class WidgetUploadResponseDto extends createZodDto(attachmentPresignResponseSchema) {}
export class WidgetAttachmentDto extends createZodDto(widgetAttachmentSchema) {}
export class WidgetDownloadQueryDto extends createZodDto(attachmentDownloadQuerySchema) {}
export class WidgetDownloadDto extends createZodDto(
  z.object({ attachment: widgetAttachmentSchema, url: z.url(), expiresAt: z.iso.datetime() }),
) {}
