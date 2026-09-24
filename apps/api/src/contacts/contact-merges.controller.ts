import type { ContactDetail, ContactMergePreview } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { contactContext } from './contact-context.js';
import { ContactMergeService } from './contact-merge.service.js';
import {
  ContactDetailDto,
  ContactIdParamDto,
  ContactMergeParamDto,
  ContactMergePreviewDto,
  ContactMergePreviewQueryDto,
  ContactMergeRequestDto,
} from './dto.js';

/**
 * Merging contacts (M1-13). The contact in the path is always the **survivor**:
 * the one whose name and details are kept.
 *
 * Merging and undoing need `contact:write`, like "Not the same" does
 * (DOMAIN-RULES §1.2): whoever may work a ticket may decide two records are one
 * person, and a Viewer may not. The preview is a read.
 */
@Controller('api/brands/:brandId/contacts/:contactId')
export class ContactMergesController {
  readonly #merges: ContactMergeService;

  constructor(@Inject(ContactMergeService) merges: ContactMergeService) {
    this.#merges = merges;
  }

  @Get('merge-preview')
  @Requires('contact:read')
  @ZodSerializerDto(ContactMergePreviewDto)
  preview(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
    @Query(new ZodValidationPipe(ContactMergePreviewQueryDto))
    { otherContactId }: ContactMergePreviewQueryDto,
  ): Promise<ContactMergePreview> {
    return this.#merges.preview(contactContext(), contactId, otherContactId);
  }

  @Post('merge')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  merge(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
    @Body(new ZodValidationPipe(ContactMergeRequestDto)) body: ContactMergeRequestDto,
  ): Promise<ContactDetail> {
    return this.#merges.merge(contactContext(), contactId, body);
  }

  @Post('merges/:mergeId/undo')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  undo(
    @Param(new ZodValidationPipe(ContactMergeParamDto)) {
      contactId,
      mergeId,
    }: ContactMergeParamDto,
  ): Promise<ContactDetail> {
    return this.#merges.undo(contactContext(), contactId, mergeId);
  }
}
