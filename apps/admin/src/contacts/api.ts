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
  ContactNoteRequest,
  ContactRefusal,
  ContactSearchQuery,
  ContactTimeline,
  ContactUpdateRequest,
  IdentityProblem,
} from '@helpdock/schemas';

/**
 * Everything the contact and account screens need, and nothing else.
 * `MockContactsApi` is the fixture the unit tests and the mock Playwright
 * projects run against; `HttpContactsApi` is the real service (M1-04).
 *
 * The shape mirrors `StaffApi`: one interface, two adapters, and failures that
 * cross as a code rather than as a message, so the sentence a person reads is
 * always a translated string (packages/i18n README).
 */
export interface ContactsApi {
  listContacts(brandId: string, query?: ContactSearchQuery): Promise<ContactList>;
  contact(brandId: string, contactId: string): Promise<ContactDetail>;
  timeline(brandId: string, contactId: string): Promise<ContactTimeline>;

  createContact(brandId: string, request: ContactCreateRequest): Promise<ContactDetail>;
  updateContact(
    brandId: string,
    contactId: string,
    request: ContactUpdateRequest,
  ): Promise<ContactDetail>;
  addIdentity(
    brandId: string,
    contactId: string,
    request: ContactIdentityInput,
  ): Promise<ContactDetail>;
  removeIdentity(brandId: string, contactId: string, identityId: string): Promise<ContactDetail>;
  addNote(brandId: string, contactId: string, request: ContactNoteRequest): Promise<ContactDetail>;
  dismissDuplicate(
    brandId: string,
    contactId: string,
    suggestionId: string,
  ): Promise<ContactDetail>;
  anonymise(brandId: string, contactId: string): Promise<ContactDetail>;

  listAccounts(brandId: string, query?: AccountSearchQuery): Promise<AccountList>;
  account(brandId: string, accountId: string): Promise<AccountDetail>;
  createAccount(brandId: string, request: AccountCreateRequest): Promise<Account>;
  updateAccount(
    brandId: string,
    accountId: string,
    request: AccountUpdateRequest,
  ): Promise<Account>;
}

/**
 * A contact action refused by a rule rather than by a permission. `reason`
 * picks the catalog key and `problem` narrows it for an identifier, so the hint
 * under a field can say "that is not an email address" rather than "that did
 * not work".
 */
export class ContactError extends Error {
  readonly reason: ContactRefusal;
  readonly problem: IdentityProblem | undefined;

  constructor(reason: ContactRefusal, problem?: IdentityProblem) {
    super(`contact: ${reason}`);
    this.name = 'ContactError';
    this.reason = reason;
    this.problem = problem;
  }
}

export const isContactError = (error: unknown): error is ContactError =>
  error instanceof ContactError;
