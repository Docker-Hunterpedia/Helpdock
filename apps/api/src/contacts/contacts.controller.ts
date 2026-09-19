import type { ContactDetail, ContactList, ContactTimeline } from '@helpdock/schemas';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { contactContext } from './contact-context.js';
import { ContactsService } from './contacts.service.js';
import {
  ContactCreateRequestDto,
  ContactDetailDto,
  ContactDuplicateParamDto,
  ContactIdentityInputDto,
  ContactIdentityParamDto,
  ContactIdParamDto,
  ContactListDto,
  ContactNoteRequestDto,
  ContactSearchQueryDto,
  ContactTimelineDto,
  ContactUpdateRequestDto,
} from './dto.js';

/**
 * Contacts for one brand. Reads need `contact:read`, which every role holds;
 * writes need `contact:write`, which a Viewer does not (DOMAIN-RULES §1.2).
 * Erasure asks for `contact:write` at the route and for Admin inside the
 * service, because the route layer can only answer "may you write here" and
 * §11 asks a narrower question.
 *
 * The brand comes from the `:brandId` path parameter, so the permission is
 * checked in that brand and the transaction names only that brand
 * (ARCHITECTURE §6). Nothing in this file filters by brand itself: the
 * row-level security policies do it, and a filter written by hand is a filter
 * that can be forgotten.
 *
 * **Every parameter names its schema**, as `StaffController` does and for the
 * reason its comment gives: the global pipe finds a DTO through
 * `design:paramtypes`, which a build that drops decorator metadata does not
 * emit.
 */
@Controller('api/brands/:brandId/contacts')
export class ContactsController {
  readonly #contacts: ContactsService;

  constructor(@Inject(ContactsService) contacts: ContactsService) {
    this.#contacts = contacts;
  }

  @Get()
  @Requires('contact:read')
  @ZodSerializerDto(ContactListDto)
  list(
    @Query(new ZodValidationPipe(ContactSearchQueryDto)) query: ContactSearchQueryDto,
  ): Promise<ContactList> {
    return this.#contacts.list(contactContext(), query);
  }

  @Post()
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  create(
    @Body(new ZodValidationPipe(ContactCreateRequestDto)) body: ContactCreateRequestDto,
  ): Promise<ContactDetail> {
    return this.#contacts.create(contactContext(), body);
  }

  @Get(':contactId')
  @Requires('contact:read')
  @ZodSerializerDto(ContactDetailDto)
  detail(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
  ): Promise<ContactDetail> {
    return this.#contacts.detail(contactContext(), contactId);
  }

  /**
   * The tickets this viewer may see, plus the count of the ones they may not
   * (DOMAIN-RULES §1.2). Empty until M1-02, through the provider seam.
   */
  @Get(':contactId/timeline')
  @Requires('contact:read')
  @ZodSerializerDto(ContactTimelineDto)
  timeline(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
  ): Promise<ContactTimeline> {
    return this.#contacts.timeline(contactContext(), contactId);
  }

  @Patch(':contactId')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  update(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
    @Body(new ZodValidationPipe(ContactUpdateRequestDto)) body: ContactUpdateRequestDto,
  ): Promise<ContactDetail> {
    return this.#contacts.update(contactContext(), contactId, body);
  }

  @Post(':contactId/identities')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  addIdentity(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
    @Body(new ZodValidationPipe(ContactIdentityInputDto)) body: ContactIdentityInputDto,
  ): Promise<ContactDetail> {
    return this.#contacts.addIdentity(contactContext(), contactId, body);
  }

  @Delete(':contactId/identities/:identityId')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  removeIdentity(
    @Param(new ZodValidationPipe(ContactIdentityParamDto))
    { contactId, identityId }: ContactIdentityParamDto,
  ): Promise<ContactDetail> {
    return this.#contacts.removeIdentity(contactContext(), contactId, identityId);
  }

  @Post(':contactId/notes')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  addNote(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
    @Body(new ZodValidationPipe(ContactNoteRequestDto)) body: ContactNoteRequestDto,
  ): Promise<ContactDetail> {
    return this.#contacts.addNote(contactContext(), contactId, body);
  }

  /** "Not the same": the other half of the merge M1-13 ships. */
  @Post(':contactId/duplicates/:suggestionId/dismiss')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  dismissDuplicate(
    @Param(new ZodValidationPipe(ContactDuplicateParamDto))
    { contactId, suggestionId }: ContactDuplicateParamDto,
  ): Promise<ContactDetail> {
    return this.#contacts.dismissDuplicate(contactContext(), contactId, suggestionId);
  }

  @Post(':contactId/anonymise')
  @Requires('contact:write')
  @ZodSerializerDto(ContactDetailDto)
  anonymise(
    @Param(new ZodValidationPipe(ContactIdParamDto)) { contactId }: ContactIdParamDto,
  ): Promise<ContactDetail> {
    return this.#contacts.anonymise(contactContext(), contactId);
  }
}
