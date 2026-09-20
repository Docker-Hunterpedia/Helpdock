import {
  attachmentDownloadQuerySchema,
  attachmentDownloadSchema,
  attachmentParamSchema,
  attachmentPresignRequestSchema,
  attachmentPresignResponseSchema,
  attachmentSchema,
  ticketParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The attachment schemas as Nest DTOs, declared here for the reason
 * `routes/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 *
 * Every handler names an output DTO with `@ZodSerializerDto`, so `s3_key` and
 * `uploader_id` cannot leak by being returned, and names its input schema on
 * the parameter, which `pnpm check:validation` enforces.
 */

export class AttachmentDto extends createZodDto(attachmentSchema) {}
export class AttachmentPresignResponseDto extends createZodDto(attachmentPresignResponseSchema) {}
export class AttachmentDownloadDto extends createZodDto(attachmentDownloadSchema) {}

export class AttachmentPresignRequestDto extends createZodDto(attachmentPresignRequestSchema) {}
export class AttachmentDownloadQueryDto extends createZodDto(attachmentDownloadQuerySchema) {}

export class AttachmentTicketParamDto extends createZodDto(ticketParamSchema) {}
export class AttachmentParamDto extends createZodDto(attachmentParamSchema) {}
