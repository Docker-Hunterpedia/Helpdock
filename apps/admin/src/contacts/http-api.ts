import type {
  Account,
  AccountCreateRequest,
  AccountDetail,
  AccountList,
  AccountSearchQuery,
  AccountUpdateRequest,
  ContactCreateRequest,
  ContactDetail,
  ContactIdentityInput,
  ContactList,
  ContactMergePreview,
  ContactMergeRequest,
  ContactNoteRequest,
  ContactSearchQuery,
  ContactTimeline,
  ContactUpdateRequest,
} from '@helpdock/schemas';
import {
  accountDetailSchema,
  accountListSchema,
  accountSchema,
  contactDetailSchema,
  contactListSchema,
  contactMergePreviewSchema,
  contactTimelineSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { ContactsApi } from './api.js';

/**
 * The real contacts service (M1-04). It shares its {@link HttpTransport} with
 * `HttpAuthApi`, so there is one access token and one refresh in the app.
 *
 * Every response is parsed through the schema `apps/api` declared it with, so a
 * shape the two disagree about fails here rather than three components deep.
 */
export class HttpContactsApi implements ContactsApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async listContacts(brandId: string, query: ContactSearchQuery = {}): Promise<ContactList> {
    return contactListSchema.parse(
      await this.#transport.request('GET', `${this.#contacts(brandId)}${queryString(query)}`),
    );
  }

  async contact(brandId: string, contactId: string): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request('GET', this.#contact(brandId, contactId)),
    );
  }

  async timeline(brandId: string, contactId: string): Promise<ContactTimeline> {
    return contactTimelineSchema.parse(
      await this.#transport.request('GET', `${this.#contact(brandId, contactId)}/timeline`),
    );
  }

  async createContact(brandId: string, request: ContactCreateRequest): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request('POST', this.#contacts(brandId), request),
    );
  }

  async updateContact(
    brandId: string,
    contactId: string,
    request: ContactUpdateRequest,
  ): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request('PATCH', this.#contact(brandId, contactId), request),
    );
  }

  async addIdentity(
    brandId: string,
    contactId: string,
    request: ContactIdentityInput,
  ): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request(
        'POST',
        `${this.#contact(brandId, contactId)}/identities`,
        request,
      ),
    );
  }

  async removeIdentity(
    brandId: string,
    contactId: string,
    identityId: string,
  ): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request(
        'DELETE',
        `${this.#contact(brandId, contactId)}/identities/${encodeURIComponent(identityId)}`,
      ),
    );
  }

  async addNote(
    brandId: string,
    contactId: string,
    request: ContactNoteRequest,
  ): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request('POST', `${this.#contact(brandId, contactId)}/notes`, request),
    );
  }

  async dismissDuplicate(
    brandId: string,
    contactId: string,
    suggestionId: string,
  ): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request(
        'POST',
        `${this.#contact(brandId, contactId)}/duplicates/${encodeURIComponent(suggestionId)}/dismiss`,
      ),
    );
  }

  async anonymise(brandId: string, contactId: string): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request('POST', `${this.#contact(brandId, contactId)}/anonymise`),
    );
  }

  async mergePreview(
    brandId: string,
    contactId: string,
    otherContactId: string,
  ): Promise<ContactMergePreview> {
    return contactMergePreviewSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#contact(brandId, contactId)}/merge-preview${queryString({ otherContactId })}`,
      ),
    );
  }

  async mergeContacts(
    brandId: string,
    survivorId: string,
    request: ContactMergeRequest,
  ): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request('POST', `${this.#contact(brandId, survivorId)}/merge`, request),
    );
  }

  async undoMerge(brandId: string, survivorId: string, mergeId: string): Promise<ContactDetail> {
    return contactDetailSchema.parse(
      await this.#transport.request(
        'POST',
        `${this.#contact(brandId, survivorId)}/merges/${encodeURIComponent(mergeId)}/undo`,
      ),
    );
  }

  // ------------------------------------------------------------------

  async listAccounts(brandId: string, query: AccountSearchQuery = {}): Promise<AccountList> {
    return accountListSchema.parse(
      await this.#transport.request('GET', `${this.#accounts(brandId)}${queryString(query)}`),
    );
  }

  async account(brandId: string, accountId: string): Promise<AccountDetail> {
    return accountDetailSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#accounts(brandId)}/${encodeURIComponent(accountId)}`,
      ),
    );
  }

  async createAccount(brandId: string, request: AccountCreateRequest): Promise<Account> {
    return accountSchema.parse(
      await this.#transport.request('POST', this.#accounts(brandId), request),
    );
  }

  async updateAccount(
    brandId: string,
    accountId: string,
    request: AccountUpdateRequest,
  ): Promise<Account> {
    return accountSchema.parse(
      await this.#transport.request(
        'PATCH',
        `${this.#accounts(brandId)}/${encodeURIComponent(accountId)}`,
        request,
      ),
    );
  }

  #contacts(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/contacts`;
  }

  #contact(brandId: string, contactId: string): string {
    return `${this.#contacts(brandId)}/${encodeURIComponent(contactId)}`;
  }

  #accounts(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/accounts`;
  }
}

/** Only the entries that are set; an empty filter is no parameter at all. */
const queryString = (query: Record<string, unknown>): string => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const rendered = params.toString();

  return rendered === '' ? '' : `?${rendered}`;
};
