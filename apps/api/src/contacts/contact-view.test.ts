import type {
  Account as AccountRow,
  ContactIdentity as ContactIdentityRow,
  ContactNote as ContactNoteRow,
  Contact as ContactRow,
  User,
} from '@helpdock/db';
import type { ContactIdentityKind } from '@helpdock/schemas';
import { contactSummarySchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  byContact,
  channelsOf,
  identityView,
  noteView,
  primaryIdentityOf,
  summaryView,
} from './contact-view.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const CONTACT = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const AT = new Date('2026-09-19T10:00:00.000Z');

const identity = (
  overrides: Partial<ContactIdentityRow> & { kind: ContactIdentityKind; value: string },
): ContactIdentityRow => ({
  id: `0192c3f0-1a2b-7c3d-8e4f-00000000000${overrides.kind.length}`,
  brandId: BRAND,
  contactId: CONTACT,
  verified: false,
  verifiedAt: null,
  source: 'agent',
  createdAt: AT,
  ...overrides,
});

const contact = (overrides: Partial<ContactRow> = {}): ContactRow => ({
  id: CONTACT,
  brandId: BRAND,
  accountId: null,
  name: 'Mona Khalil',
  locale: null,
  timezone: null,
  externalId: null,
  custom: {},
  notesCount: 0,
  createdAt: AT,
  updatedAt: AT,
  anonymisedAt: null,
  ...overrides,
});

describe('primaryIdentityOf', () => {
  it('prefers a verified email, which is what the row is headed by', () => {
    const rows = [
      identity({ kind: 'phone', value: '+49301234567' }),
      identity({ kind: 'email', value: 'mona@example.com', verified: true }),
    ];

    expect(primaryIdentityOf(rows)?.value).toBe('mona@example.com');
  });

  it('falls back to any verified identifier before an unverified email', () => {
    const rows = [
      identity({ kind: 'email', value: 'typed@example.com' }),
      identity({ kind: 'telegram', value: '42', verified: true }),
    ];

    expect(primaryIdentityOf(rows)?.kind).toBe('telegram');
  });

  it('falls back to an unverified email before a phone number', () => {
    const rows = [
      identity({ kind: 'phone', value: '+49301234567' }),
      identity({ kind: 'email', value: 'typed@example.com' }),
    ];

    expect(primaryIdentityOf(rows)?.kind).toBe('email');
  });

  it('heads an anonymous visitor with their visitor id', () => {
    const rows = [identity({ kind: 'visitor', value: '7f3a' })];

    expect(primaryIdentityOf(rows)?.kind).toBe('visitor');
  });

  it('is null for a contact with nothing at all', () => {
    expect(primaryIdentityOf([])).toBeNull();
  });
});

describe('channelsOf', () => {
  it('deduplicates and keeps the icon order the design fixes', () => {
    const rows = [
      identity({ kind: 'telegram', value: '42' }),
      identity({ kind: 'email', value: 'a@example.com' }),
      identity({ kind: 'email', value: 'b@example.com' }),
    ];

    expect(channelsOf(rows)).toEqual(['email', 'telegram']);
  });

  it('is empty for a contact with no identifier', () => {
    expect(channelsOf([])).toEqual([]);
  });
});

describe('identityView', () => {
  it('publishes the verification state and the date it was proven', () => {
    const view = identityView(
      identity({ kind: 'email', value: 'mona@example.com', verified: true, verifiedAt: AT }),
    );

    expect(view).toMatchObject({ verified: true, verifiedAt: AT.toISOString() });
  });

  it('leaves the date null while nothing has proven it', () => {
    expect(identityView(identity({ kind: 'phone', value: '+49301234567' })).verifiedAt).toBeNull();
  });
});

describe('summaryView', () => {
  it('parses against the schema the response is serialised through', () => {
    const view = summaryView(contact(), {
      identities: [identity({ kind: 'email', value: 'mona@example.com', verified: true })],
      account: undefined,
      stats: undefined,
    });

    expect(contactSummarySchema.safeParse(view).success).toBe(true);
  });

  it('reports no tickets while the provider has none to report', () => {
    const view = summaryView(contact(), { identities: [], account: undefined, stats: undefined });

    expect(view.stats).toMatchObject({ openTickets: 0, csat: null });
  });

  it('names the account rather than repeating it', () => {
    const account: AccountRow = {
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
      brandId: BRAND,
      name: 'Acme GmbH',
      domain: 'acme.example',
      custom: {},
      createdAt: AT,
      updatedAt: AT,
    };

    const view = summaryView(contact({ accountId: account.id }), {
      identities: [],
      account,
      stats: undefined,
    });

    expect(view.account).toEqual({ id: account.id, name: 'Acme GmbH' });
  });

  it('marks an erased contact so the screen can say so', () => {
    const view = summaryView(contact({ anonymisedAt: AT }), {
      identities: [],
      account: undefined,
      stats: undefined,
    });

    expect(view.anonymised).toBe(true);
  });
});

describe('noteView', () => {
  const note: ContactNoteRow = {
    id: '0192c3f0-1a2b-7c3d-8e4f-0000000000n1',
    brandId: BRAND,
    contactId: CONTACT,
    authorId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
    bodyText: 'Prefers Arabic.',
    createdAt: AT,
  };

  it('names the author', () => {
    const author = { id: note.authorId, name: 'Lina Haddad' } as User;

    expect(noteView(note, author).authorName).toBe('Lina Haddad');
  });

  it('says "Former staff" when the account behind it is gone', () => {
    expect(noteView(note, null).authorName).toBe('Former staff');
  });
});

describe('byContact', () => {
  it('groups rows by the contact they belong to', () => {
    const grouped = byContact([
      { contactId: 'a', n: 1 },
      { contactId: 'b', n: 2 },
      { contactId: 'a', n: 3 },
    ]);

    expect(grouped.get('a')).toHaveLength(2);
    expect(grouped.get('b')).toHaveLength(1);
  });

  it('answers nothing for a contact with no rows', () => {
    expect(byContact([]).get('a')).toBeUndefined();
  });
});
