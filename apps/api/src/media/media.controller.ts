import type { Attachment, AttachmentDownload, AttachmentPresignResponse } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { Principal } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import {
  AttachmentDownloadDto,
  AttachmentDownloadQueryDto,
  AttachmentDto,
  AttachmentParamDto,
  AttachmentPresignRequestDto,
  AttachmentPresignResponseDto,
  AttachmentTicketParamDto,
} from './dto.js';
import { MediaService } from './media.service.js';

/**
 * M1-10 over HTTP. Four routes, hung off the ticket they belong to, because an
 * attachment has no life of its own: it is authorised, scoped and deleted
 * through its parent (DOMAIN-RULES §4.5, §11).
 *
 * `ticket:write` uploads, `ticket:read` downloads. That is layer 1 of
 * DOMAIN-RULES §1.3 and is what decides *which brand* the transaction names;
 * which **department** it reaches is layer 3's and is not repeated here. An
 * agent asking for an attachment on another department's ticket gets a 404 from
 * the policy, by presign, by confirm, by download and by delete alike.
 *
 * There are no screens for this yet. The composer and the thread are M1-15,
 * built from the `Admin · ticket view` artboard; what they need is a stable
 * contract and a client helper (`apps/admin/src/media/upload.ts`).
 */
@Controller('api/brands/:brandId/tickets/:ticketId/attachments')
export class MediaController {
  readonly #media: MediaService;

  constructor(@Inject(MediaService) media: MediaService) {
    this.#media = media;
  }

  /**
   * "I am about to send this." Answers a row id and a URL that accepts exactly
   * one object of exactly that size and type, for five minutes.
   */
  @Post('presign')
  @Requires('ticket:write')
  @ZodSerializerDto(AttachmentPresignResponseDto)
  async presign(
    @Param(new ZodValidationPipe(AttachmentTicketParamDto))
    { brandId, ticketId }: AttachmentTicketParamDto,
    @Body(new ZodValidationPipe(AttachmentPresignRequestDto)) body: AttachmentPresignRequestDto,
  ): Promise<AttachmentPresignResponse> {
    return this.#media.presign(brandId, ticketId, this.#principal(), body);
  }

  /**
   * "It is uploaded." Checks the object is really there and really that size,
   * then enqueues `media.process` through the outbox in the same transaction.
   */
  @Post(':attachmentId/confirm')
  @Requires('ticket:write')
  @ZodSerializerDto(AttachmentDto)
  async confirm(
    @Param(new ZodValidationPipe(AttachmentParamDto))
    { brandId, ticketId, attachmentId }: AttachmentParamDto,
  ): Promise<Attachment> {
    return this.#media.confirm(brandId, ticketId, attachmentId);
  }

  /**
   * The row, and a five-minute URL for the variant asked for — but only once
   * the pipeline has finished with it. A `processing` row answers 409, which is
   * what a client polls on.
   */
  @Get(':attachmentId')
  @Requires('ticket:read')
  @ZodSerializerDto(AttachmentDownloadDto)
  async download(
    @Param(new ZodValidationPipe(AttachmentParamDto))
    { brandId, ticketId, attachmentId }: AttachmentParamDto,
    @Query(new ZodValidationPipe(AttachmentDownloadQueryDto)) query: AttachmentDownloadQueryDto,
  ): Promise<AttachmentDownload> {
    return this.#media.download(brandId, ticketId, attachmentId, query);
  }

  /**
   * Discards an upload that was never sent. A `ready` attachment belongs to a
   * message and goes with the ticket (DOMAIN-RULES §11), so this refuses it.
   */
  @Delete(':attachmentId')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(AttachmentParamDto))
    { ticketId, attachmentId }: AttachmentParamDto,
  ): Promise<void> {
    await this.#media.remove(ticketId, attachmentId);
  }

  #principal(): Principal {
    const principal = requireRequestContext().principal;
    /* c8 ignore next 3 -- the guard refuses the request before a handler runs. */
    if (principal === null) {
      throw new Error('The authentication guard let an unauthenticated request through');
    }

    return principal;
  }
}
