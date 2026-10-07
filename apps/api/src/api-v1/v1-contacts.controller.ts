import {
  CONTACT_PAGE_SIZE,
  type V1Contact,
  type V1ContactList,
  type V1ContactUpsert,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { ContactsRepository } from '../contacts/contacts.repository.js';
import { type ContactContext, ContactsService } from '../contacts/contacts.service.js';
import { getTx } from '../context/request-context.js';
import { apiKeyPrincipal } from './api-key-context.js';
import {
  V1ContactDto,
  V1ContactListDto,
  V1ContactParamDto,
  V1ContactSearchQueryDto,
  V1ContactUpsertDto,
  V1ContactUpsertRequestDto,
} from './dto.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { readV1Contact, readV1Contacts } from './v1-contact-view.js';

/**
 * M8-02: contacts over the public API — search, read, and upsert by the
 * integration's own id or by an address. Writes go through `ContactsService`,
 * so normalisation, the "identifier taken" refusal and the audit row are the
 * admin's; the audit row names the key.
 *
 * The key acts as an Agent would: it may create and correct contacts, and
 * never erase one (DOMAIN-RULES §11 keeps that to an Admin).
 */
@Controller('api/v1/contacts')
export class V1ContactsController {
  readonly #contacts: ContactsService;
  readonly #repository: ContactsRepository;

  constructor(
    @Inject(ContactsService) contacts: ContactsService,
    @Inject(ContactsRepository) repository: ContactsRepository,
  ) {
    this.#contacts = contacts;
    this.#repository = repository;
  }

  @Get()
  @Requires('contacts:read')
  @ZodSerializerDto(V1ContactListDto)
  async search(
    @Query(new ZodValidationPipe(V1ContactSearchQueryDto)) query: V1ContactSearchQueryDto,
  ): Promise<V1ContactList> {
    const tx = getTx();
    const page = await this.#repository.list(tx, {
      search: query.search,
      cursor: query.cursor,
      limit: query.limit ?? CONTACT_PAGE_SIZE,
    });
    return {
      contacts: await readV1Contacts(
        tx,
        page.rows.map((row) => row.id),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Always 200: `created` says whether a contact was made or an existing one
   * matched, which a replayed answer carries too.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Requires('contacts:write')
  @UseInterceptors(IdempotencyInterceptor)
  @ZodSerializerDto(V1ContactUpsertDto)
  async upsert(
    @Body(new ZodValidationPipe(V1ContactUpsertRequestDto)) body: V1ContactUpsertRequestDto,
  ): Promise<V1ContactUpsert> {
    const { contactId, created } = await this.#contacts.upsert(contactContext(), body);
    return { contact: await this.#require(contactId), created };
  }

  @Get(':contactId')
  @Requires('contacts:read')
  @ZodSerializerDto(V1ContactDto)
  find(
    @Param(new ZodValidationPipe(V1ContactParamDto)) { contactId }: V1ContactParamDto,
  ): Promise<V1Contact> {
    return this.#require(contactId);
  }

  async #require(contactId: string): Promise<V1Contact> {
    const contact = await readV1Contact(getTx(), contactId);
    if (contact === undefined) {
      throw new NotFoundException('No such contact');
    }
    return contact;
  }
}

const contactContext = (): ContactContext => {
  const key = apiKeyPrincipal();
  return {
    tx: getTx(),
    brandId: key.brandId,
    actor: { userId: key.id, role: 'agent', principalType: 'apikey' },
  };
};
