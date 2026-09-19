import type {
  Account,
  AccountCreateRequest,
  AccountDetail,
  AccountList,
  AccountSearchQuery,
  AccountUpdateRequest,
  ContactCreateRequest,
  ContactDetail,
  ContactDuplicateSuggestion,
  ContactIdentity,
  ContactIdentityInput,
  ContactIdentityKind,
  ContactList,
  ContactNote,
  ContactNoteRequest,
  ContactSearchQuery,
  ContactStats,
  ContactTimeline,
  ContactUpdateRequest,
} from '@helpdock/schemas';
import { CONTACT_PAGE_SIZE, normaliseIdentity } from '@helpdock/schemas';
import { ContactError, type ContactsApi } from './api.js';

/**
 * The fixture the contact screens run against until an install is in front of
 * them, and the one the browser suite drives.
 *
 * It is deliberately the whole of `ContactsApi` including the refusals, so the
 * screens exercise the same states the real service produces: a verified
 * address beside an unverified one, an anonymous visitor with nothing but a
 * visitor id, an open duplicate suggestion, an erased contact, and the two
 * answers an identifier can get wrong.
 *
 * The rows are the ones on the `Admin/Contacts` and `Admin/Contact` artboards,
 * so a screenshot of the fixture and the drawing are the same picture.
 */

export const MOCK_BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const ACME = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
const NORDWIND = '0192c3f0-1a2b-7c3d-8e4f-0000000000a2';

export const MOCK_CONTACT_MONA = '0192c3f0-1a2b-7c3d-8e4f-0000000000c1';
export const MOCK_CONTACT_GMAIL = '0192c3f0-1a2b-7c3d-8e4f-0000000000c2';
export const MOCK_CONTACT_ARABIC = '0192c3f0-1a2b-7c3d-8e4f-0000000000c3';
export const MOCK_CONTACT_ACCOUNT = '0192c3f0-1a2b-7c3d-8e4f-0000000000c4';
export const MOCK_CONTACT_VISITOR = '0192c3f0-1a2b-7c3d-8e4f-0000000000c5';

export const MOCK_DUPLICATE = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

/** The address the "already taken" refusal is demonstrated with. */
export const MOCK_TAKEN_EMAIL = 'mona@example.com';

const iso = (daysAgo: number): string =>
  new Date(Date.UTC(2026, 8, 19, 9, 0, 0) - daysAgo * 24 * 60 * 60 * 1000).toISOString();

interface MockContact {
  id: string;
  name: string;
  accountId: string | null;
  locale: 'en' | 'ar' | null;
  timezone: string | null;
  externalId: string | null;
  custom: Record<string, unknown>;
  identities: ContactIdentity[];
  notes: ContactNote[];
  stats: ContactStats;
  anonymised: boolean;
  createdAt: string;
  updatedAt: string;
}

const stats = (overrides: Partial<ContactStats> = {}): ContactStats => ({
  openTickets: 0,
  totalTickets: 0,
  csat: null,
  averageFirstReplySeconds: null,
  lastTicketAt: null,
  ...overrides,
});

const identity = (
  id: string,
  kind: ContactIdentityKind,
  value: string,
  verified = false,
): ContactIdentity => ({
  id,
  kind,
  value,
  verified,
  verifiedAt: verified ? iso(30) : null,
  source: verified ? 'email.inbound' : 'agent',
});

const seedAccounts = (): Account[] => [
  {
    id: ACME,
    name: 'Acme GmbH',
    domain: 'acme.example',
    custom: {},
    contactCount: 2,
    createdAt: iso(120),
  },
  {
    id: NORDWIND,
    name: 'Nordwind AG',
    domain: null,
    custom: {},
    contactCount: 0,
    createdAt: iso(60),
  },
];

const seedContacts = (): MockContact[] => [
  {
    id: MOCK_CONTACT_MONA,
    name: 'Mona Khalil',
    accountId: ACME,
    locale: 'en',
    timezone: 'Europe/Berlin',
    externalId: 'CUST-10492',
    custom: { plan: 'Business', tag: 'vip' },
    identities: [
      identity('0192c3f0-1a2b-7c3d-8e4f-0000000000e1', 'email', MOCK_TAKEN_EMAIL, true),
      identity('0192c3f0-1a2b-7c3d-8e4f-0000000000e2', 'phone', '+49301234567'),
      identity(
        '0192c3f0-1a2b-7c3d-8e4f-0000000000e3',
        'visitor',
        '0192c3f0-1a2b-7c3d-8e4f-7f3a000000c2',
      ),
    ],
    notes: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
        bodyText: 'Prefers a call before any billing change.',
        authorId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
        authorName: 'Lina Haddad',
        createdAt: iso(4),
      },
    ],
    stats: stats({ openTickets: 2, totalTickets: 6, csat: 92, averageFirstReplySeconds: 2_700 }),
    anonymised: false,
    createdAt: iso(200),
    updatedAt: iso(1),
  },
  {
    id: MOCK_CONTACT_GMAIL,
    name: 'M. Khalil',
    accountId: null,
    locale: null,
    timezone: null,
    externalId: null,
    custom: {},
    identities: [identity('0192c3f0-1a2b-7c3d-8e4f-0000000000e4', 'email', 'mona.k@gmail.com')],
    notes: [],
    stats: stats({ totalTickets: 1 }),
    anonymised: false,
    createdAt: iso(8),
    updatedAt: iso(8),
  },
  {
    id: MOCK_CONTACT_ARABIC,
    name: 'سارة الحسن',
    accountId: null,
    locale: 'ar',
    timezone: 'Asia/Damascus',
    externalId: null,
    custom: {},
    identities: [
      identity('0192c3f0-1a2b-7c3d-8e4f-0000000000e5', 'phone', '+963931234567'),
      identity('0192c3f0-1a2b-7c3d-8e4f-0000000000e6', 'telegram', '884413201', true),
    ],
    notes: [],
    stats: stats({ openTickets: 1, totalTickets: 3, csat: 80 }),
    anonymised: false,
    createdAt: iso(40),
    updatedAt: iso(2),
  },
  {
    id: MOCK_CONTACT_ACCOUNT,
    name: 'Jonas Weber',
    accountId: ACME,
    locale: 'en',
    timezone: 'Europe/Berlin',
    externalId: 'CUST-10500',
    custom: { plan: 'Business' },
    identities: [
      identity('0192c3f0-1a2b-7c3d-8e4f-0000000000e7', 'email', 'jonas@acme.example', true),
    ],
    notes: [],
    stats: stats({ totalTickets: 4, csat: 100 }),
    anonymised: false,
    createdAt: iso(90),
    updatedAt: iso(6),
  },
  {
    id: MOCK_CONTACT_VISITOR,
    name: 'Visitor 7f3a…c2',
    accountId: null,
    locale: null,
    timezone: null,
    externalId: null,
    custom: {},
    identities: [
      identity(
        '0192c3f0-1a2b-7c3d-8e4f-0000000000e8',
        'visitor',
        '0192c3f0-1a2b-7c3d-8e4f-7f3a000000c3',
      ),
    ],
    notes: [],
    stats: stats(),
    anonymised: false,
    createdAt: iso(0),
    updatedAt: iso(0),
  },
];

const seedDuplicates = (): {
  id: string;
  contactId: string;
  otherContactId: string;
  reason: ContactIdentityKind;
  createdAt: string;
}[] => [
  {
    id: MOCK_DUPLICATE,
    contactId: MOCK_CONTACT_GMAIL,
    otherContactId: MOCK_CONTACT_MONA,
    reason: 'email',
    createdAt: iso(8),
  },
];

export class MockContactsApi implements ContactsApi {
  #accounts = seedAccounts();
  #contacts = seedContacts();
  #duplicates = seedDuplicates();
  #sequence = 0;

  async listContacts(_brandId: string, query: ContactSearchQuery = {}): Promise<ContactList> {
    const term = query.search?.trim().toLowerCase() ?? '';
    const matches = this.#contacts.filter((contact) => {
      const searched =
        term === '' ||
        contact.name.toLowerCase().includes(term) ||
        contact.identities.some((row) => row.value.toLowerCase().includes(term));
      const account = query.accountId === undefined || contact.accountId === query.accountId;
      const open = query.hasOpenTickets !== true || contact.stats.openTickets > 0;
      const duplicate =
        query.duplicates !== true ||
        this.#duplicates.some(
          (row) => row.contactId === contact.id || row.otherContactId === contact.id,
        );

      return searched && account && open && duplicate;
    });

    const limit = query.limit ?? CONTACT_PAGE_SIZE;
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const page = matches.slice(start, start + limit);

    return {
      contacts: page.map((contact) => this.#summary(contact)),
      total: matches.length,
      nextCursor: start + limit < matches.length ? String(start + limit) : null,
      duplicateCount: this.#duplicates.length,
    };
  }

  async contact(_brandId: string, contactId: string): Promise<ContactDetail> {
    return this.#detail(this.#require(contactId));
  }

  /** Empty until M1-02, exactly as the api's null provider answers. */
  async timeline(_brandId: string, contactId: string): Promise<ContactTimeline> {
    const contact = this.#require(contactId);

    return { items: [], notes: contact.notes, hiddenCount: 0 };
  }

  async createContact(_brandId: string, request: ContactCreateRequest): Promise<ContactDetail> {
    const identities = (request.identities ?? []).map((input) => this.#normalise(input));

    for (const candidate of identities) {
      this.#refuseIfTaken(candidate, null);
    }

    const contact: MockContact = {
      id: this.#nextId('c'),
      name: request.name,
      accountId: request.accountId ?? null,
      locale: request.locale ?? null,
      timezone: request.timezone ?? null,
      externalId: request.externalId ?? null,
      custom: {},
      identities: identities.map((value) =>
        identity(this.#nextId('e'), value.kind, value.value, false),
      ),
      notes: [],
      stats: stats(),
      anonymised: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.#contacts = [contact, ...this.#contacts];

    return this.#detail(contact);
  }

  async updateContact(
    _brandId: string,
    contactId: string,
    request: ContactUpdateRequest,
  ): Promise<ContactDetail> {
    const contact = this.#writable(contactId);

    if (request.name !== undefined) {
      contact.name = request.name;
    }
    if (request.accountId !== undefined) {
      contact.accountId = request.accountId ?? null;
    }
    if (request.locale !== undefined) {
      contact.locale = request.locale ?? null;
    }
    if (request.timezone !== undefined) {
      contact.timezone = request.timezone ?? null;
    }
    if (request.externalId !== undefined) {
      contact.externalId = request.externalId ?? null;
    }
    contact.updatedAt = new Date().toISOString();

    return this.#detail(contact);
  }

  async addIdentity(
    _brandId: string,
    contactId: string,
    request: ContactIdentityInput,
  ): Promise<ContactDetail> {
    const contact = this.#writable(contactId);
    const value = this.#normalise(request);
    this.#refuseIfTaken(value, contactId);

    contact.identities = [
      ...contact.identities,
      identity(this.#nextId('e'), value.kind, value.value, false),
    ];

    return this.#detail(contact);
  }

  async removeIdentity(
    _brandId: string,
    contactId: string,
    identityId: string,
  ): Promise<ContactDetail> {
    const contact = this.#writable(contactId);
    if (contact.identities.length <= 1) {
      throw new ContactError('last-identity');
    }

    contact.identities = contact.identities.filter((row) => row.id !== identityId);

    return this.#detail(contact);
  }

  async addNote(
    _brandId: string,
    contactId: string,
    request: ContactNoteRequest,
  ): Promise<ContactDetail> {
    const contact = this.#writable(contactId);
    contact.notes = [
      {
        id: this.#nextId('f'),
        bodyText: request.bodyText,
        authorId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
        authorName: 'Lina Haddad',
        createdAt: new Date().toISOString(),
      },
      ...contact.notes,
    ];

    return this.#detail(contact);
  }

  async dismissDuplicate(
    _brandId: string,
    contactId: string,
    suggestionId: string,
  ): Promise<ContactDetail> {
    this.#duplicates = this.#duplicates.filter((row) => row.id !== suggestionId);

    return this.#detail(this.#require(contactId));
  }

  async anonymise(_brandId: string, contactId: string): Promise<ContactDetail> {
    const contact = this.#writable(contactId);

    contact.name = 'Erased contact';
    contact.accountId = null;
    contact.externalId = null;
    contact.locale = null;
    contact.timezone = null;
    contact.custom = {};
    contact.notes = [];
    contact.anonymised = true;
    contact.identities = contact.identities.map((row) => ({
      ...row,
      value: `erased:${row.kind}:${row.id.replaceAll('-', '').slice(0, 32)}`,
      verified: false,
      verifiedAt: null,
      source: 'erasure',
    }));

    return this.#detail(contact);
  }

  // ------------------------------------------------------------------

  async listAccounts(_brandId: string, query: AccountSearchQuery = {}): Promise<AccountList> {
    const term = query.search?.trim().toLowerCase() ?? '';
    const matches = this.#accounts.filter(
      (account) =>
        term === '' ||
        account.name.toLowerCase().includes(term) ||
        (account.domain ?? '').toLowerCase().includes(term),
    );

    return {
      accounts: matches.map((account) => ({
        ...account,
        contactCount: this.#contacts.filter((contact) => contact.accountId === account.id).length,
      })),
      total: matches.length,
      nextCursor: null,
    };
  }

  async account(_brandId: string, accountId: string): Promise<AccountDetail> {
    const account = this.#requireAccount(accountId);
    const contacts = this.#contacts.filter((contact) => contact.accountId === accountId);

    return {
      account: { ...account, contactCount: contacts.length },
      contacts: contacts.map((contact) => this.#summary(contact)),
    };
  }

  async createAccount(_brandId: string, request: AccountCreateRequest): Promise<Account> {
    const domain = request.domain?.trim().toLowerCase() ?? '';
    if (domain !== '' && this.#accounts.some((row) => row.domain === domain)) {
      throw new ContactError('domain-taken');
    }

    const account: Account = {
      id: this.#nextId('a'),
      name: request.name,
      domain: domain === '' ? null : domain,
      custom: {},
      contactCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.#accounts = [...this.#accounts, account];

    return account;
  }

  async updateAccount(
    _brandId: string,
    accountId: string,
    request: AccountUpdateRequest,
  ): Promise<Account> {
    const account = this.#requireAccount(accountId);

    if (request.name !== undefined) {
      account.name = request.name;
    }
    if (request.domain !== undefined) {
      const domain = request.domain?.trim().toLowerCase() ?? '';
      if (
        domain !== '' &&
        this.#accounts.some((row) => row.domain === domain && row.id !== accountId)
      ) {
        throw new ContactError('domain-taken');
      }
      account.domain = domain === '' ? null : domain;
    }

    return { ...account };
  }

  // ------------------------------------------------------------------

  #normalise(input: ContactIdentityInput): { kind: ContactIdentityKind; value: string } {
    // The same function the api runs, so the fixture cannot accept a spelling
    // the real service would refuse (`packages/schemas/src/contact.ts`).
    const result = normaliseIdentity(input.kind, input.value, { defaultCallingCode: '49' });
    if (!result.ok) {
      throw new ContactError('identity-invalid', result.problem);
    }

    return { kind: input.kind, value: result.value };
  }

  #refuseIfTaken(
    candidate: { kind: ContactIdentityKind; value: string },
    selfId: string | null,
  ): void {
    const taken = this.#contacts.some(
      (contact) =>
        contact.id !== selfId &&
        contact.identities.some(
          (row) => row.kind === candidate.kind && row.value === candidate.value,
        ),
    );

    if (taken) {
      throw new ContactError('identity-taken');
    }
  }

  /**
   * The api answers 404 for a row this brand cannot see, and the transport
   * turns that into `unavailable` rather than a contact refusal. A plain error
   * is the fixture's equivalent.
   */
  #require(contactId: string): MockContact {
    const contact = this.#contacts.find((row) => row.id === contactId);
    if (contact === undefined) {
      throw new Error(`No contact ${contactId} in this brand`);
    }

    return contact;
  }

  #requireAccount(accountId: string): Account {
    const account = this.#accounts.find((row) => row.id === accountId);
    if (account === undefined) {
      throw new Error(`No account ${accountId} in this brand`);
    }

    return account;
  }

  #writable(contactId: string): MockContact {
    const contact = this.#require(contactId);
    if (contact.anonymised) {
      throw new ContactError('anonymised');
    }

    return contact;
  }

  #summary(contact: MockContact) {
    const account = this.#accounts.find((row) => row.id === contact.accountId);
    const primary =
      contact.identities.find((row) => row.kind === 'email' && row.verified) ??
      contact.identities.find((row) => row.verified) ??
      contact.identities.find((row) => row.kind === 'email') ??
      contact.identities[0] ??
      null;

    return {
      id: contact.id,
      name: contact.name,
      account: account === undefined ? null : { id: account.id, name: account.name },
      primaryIdentity: primary,
      channels: (['email', 'phone', 'telegram', 'visitor', 'external'] as const).filter((kind) =>
        contact.identities.some((row) => row.kind === kind),
      ),
      stats: contact.stats,
      anonymised: contact.anonymised,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    };
  }

  #detail(contact: MockContact): ContactDetail {
    return {
      ...this.#summary(contact),
      locale: contact.locale,
      timezone: contact.timezone,
      externalId: contact.externalId,
      custom: contact.custom,
      identities: contact.identities,
      notes: contact.notes,
      duplicates: this.#duplicatesOf(contact),
    };
  }

  #duplicatesOf(contact: MockContact): ContactDuplicateSuggestion[] {
    return this.#duplicates
      .filter((row) => row.contactId === contact.id || row.otherContactId === contact.id)
      .map((row) => {
        const otherId = row.contactId === contact.id ? row.otherContactId : row.contactId;
        const other = this.#contacts.find((candidate) => candidate.id === otherId);
        const summary = other === undefined ? null : this.#summary(other);

        return {
          id: row.id,
          reason: row.reason,
          other: {
            id: otherId,
            name: other?.name ?? 'Unknown',
            primaryIdentity: summary?.primaryIdentity ?? null,
            accountName: summary?.account?.name ?? null,
          },
          sameAccount: other?.accountId !== null && other?.accountId === contact.accountId,
          createdAt: row.createdAt,
        };
      });
  }

  #nextId(marker: string): string {
    this.#sequence += 1;

    return `0192c3f0-1a2b-7c3d-8e4f-${marker}${String(this.#sequence).padStart(11, '0')}`;
  }
}
