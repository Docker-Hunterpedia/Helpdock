import { describe, expect, it } from 'vitest';
import { isContactError } from './api.js';
import {
  MOCK_BRAND,
  MOCK_CONTACT_ARABIC,
  MOCK_CONTACT_GMAIL,
  MOCK_CONTACT_MONA,
  MOCK_CONTACT_VISITOR,
  MOCK_DUPLICATE,
  MOCK_TAKEN_EMAIL,
  MockContactsApi,
} from './mock-api.js';

/**
 * The fixture has to behave like the service, or the screens are built against
 * a world that does not exist. These are the behaviours the real api promises:
 * an identifier is unique in the brand, a duplicate suggestion is dismissible,
 * an erased contact is immutable, and a value is normalised before anything is
 * compared.
 */

const reasonOf = (error: unknown): string | undefined =>
  isContactError(error) ? error.reason : undefined;

describe('MockContactsApi', () => {
  it('lists the rows the artboard draws', async () => {
    const list = await new MockContactsApi().listContacts(MOCK_BRAND);

    expect(list.contacts).toHaveLength(5);
    expect(list.total).toBe(5);
    expect(list.duplicateCount).toBe(1);
  });

  it('searches names and identifiers alike', async () => {
    const api = new MockContactsApi();

    await expect(api.listContacts(MOCK_BRAND, { search: 'mona' })).resolves.toMatchObject({
      total: 2,
    });
    await expect(api.listContacts(MOCK_BRAND, { search: '+963' })).resolves.toMatchObject({
      total: 1,
    });
  });

  it('finds a contact by customer id', async () => {
    await expect(
      new MockContactsApi().listContacts(MOCK_BRAND, { search: 'cust-10492' }),
    ).resolves.toMatchObject({ total: 1, contacts: [{ id: MOCK_CONTACT_MONA }] });
  });

  it('leaves out anonymised contacts from the ones a merge accepts', async () => {
    const api = new MockContactsApi();
    await api.anonymise(MOCK_BRAND, MOCK_CONTACT_GMAIL);

    const all = await api.listContacts(MOCK_BRAND);
    const mergeable = await api.listContacts(MOCK_BRAND, { mergeable: true });

    expect(all.contacts.map((contact) => contact.id)).toContain(MOCK_CONTACT_GMAIL);
    expect(mergeable.contacts.map((contact) => contact.id)).not.toContain(MOCK_CONTACT_GMAIL);
    expect(mergeable.total).toBe(all.total - 1);
  });

  it('narrows to contacts with open tickets', async () => {
    const list = await new MockContactsApi().listContacts(MOCK_BRAND, { hasOpenTickets: true });

    expect(list.contacts.map((contact) => contact.id).sort()).toEqual(
      [MOCK_CONTACT_MONA, MOCK_CONTACT_ARABIC].sort(),
    );
  });

  it('narrows to the contacts a duplicate suggestion points at', async () => {
    const list = await new MockContactsApi().listContacts(MOCK_BRAND, { duplicates: true });

    expect(list.contacts.map((contact) => contact.id).sort()).toEqual(
      [MOCK_CONTACT_MONA, MOCK_CONTACT_GMAIL].sort(),
    );
  });

  it('heads an anonymous visitor with nothing but a visitor id', async () => {
    const detail = await new MockContactsApi().contact(MOCK_BRAND, MOCK_CONTACT_VISITOR);

    expect(detail.channels).toEqual(['visitor']);
    expect(detail.primaryIdentity?.kind).toBe('visitor');
  });

  it('shows the duplicate suggestion from both sides', async () => {
    const api = new MockContactsApi();

    await expect(api.contact(MOCK_BRAND, MOCK_CONTACT_MONA)).resolves.toMatchObject({
      duplicates: [{ id: MOCK_DUPLICATE }],
    });
    await expect(api.contact(MOCK_BRAND, MOCK_CONTACT_GMAIL)).resolves.toMatchObject({
      duplicates: [{ id: MOCK_DUPLICATE }],
    });
  });

  it('dismisses a suggestion and stops offering it', async () => {
    const api = new MockContactsApi();
    const detail = await api.dismissDuplicate(MOCK_BRAND, MOCK_CONTACT_MONA, MOCK_DUPLICATE);

    expect(detail.duplicates).toEqual([]);
    await expect(api.listContacts(MOCK_BRAND)).resolves.toMatchObject({ duplicateCount: 0 });
  });

  it('normalises an identifier before storing it', async () => {
    const api = new MockContactsApi();
    const created = await api.createContact(MOCK_BRAND, {
      name: 'Rami',
      identities: [{ kind: 'email', value: '  Rami@Example.COM ' }],
    });

    expect(created.identities[0]?.value).toBe('rami@example.com');
  });

  it('refuses an identifier another contact already holds', async () => {
    const api = new MockContactsApi();

    const error = await api
      .createContact(MOCK_BRAND, {
        name: 'Somebody else',
        identities: [{ kind: 'email', value: MOCK_TAKEN_EMAIL.toUpperCase() }],
      })
      .catch((caught: unknown) => caught);

    expect(reasonOf(error)).toBe('identity-taken');
  });

  it('refuses a value that is not an identifier of that kind, and says how', async () => {
    const api = new MockContactsApi();

    const error = await api
      .addIdentity(MOCK_BRAND, MOCK_CONTACT_MONA, { kind: 'email', value: 'not-an-address' })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: 'identity-invalid', problem: 'invalid-email' });
  });

  it('keeps a contact from losing its last identifier', async () => {
    const api = new MockContactsApi();
    const detail = await api.contact(MOCK_BRAND, MOCK_CONTACT_VISITOR);
    const identityId = detail.identities[0]?.id ?? '';

    const error = await api
      .removeIdentity(MOCK_BRAND, MOCK_CONTACT_VISITOR, identityId)
      .catch((caught: unknown) => caught);

    expect(reasonOf(error)).toBe('last-identity');
  });

  it('adds a note and gives it back on the detail', async () => {
    const api = new MockContactsApi();
    const detail = await api.addNote(MOCK_BRAND, MOCK_CONTACT_ARABIC, {
      bodyText: 'Calls on Sundays.',
    });

    expect(detail.notes[0]?.bodyText).toBe('Calls on Sundays.');
  });

  it('erases a contact: hashes, no account, no notes, and no further edits', async () => {
    const api = new MockContactsApi();
    const erased = await api.anonymise(MOCK_BRAND, MOCK_CONTACT_MONA);

    expect(erased.anonymised).toBe(true);
    expect(erased.account).toBeNull();
    expect(erased.notes).toEqual([]);
    expect(erased.externalId).toBeNull();
    for (const identity of erased.identities) {
      expect(identity.value).toMatch(/^erased:/);
      expect(identity.verified).toBe(false);
    }

    const error = await api
      .updateContact(MOCK_BRAND, MOCK_CONTACT_MONA, { name: 'Back again' })
      .catch((caught: unknown) => caught);

    expect(reasonOf(error)).toBe('anonymised');
  });

  it('answers an empty timeline, which is what the api answers until M1-02', async () => {
    const timeline = await new MockContactsApi().timeline(MOCK_BRAND, MOCK_CONTACT_MONA);

    expect(timeline).toMatchObject({ items: [], hiddenCount: 0 });
    expect(timeline.notes).toHaveLength(1);
  });

  it('creates an account and refuses a domain another one claims', async () => {
    const api = new MockContactsApi();
    const created = await api.createAccount(MOCK_BRAND, {
      name: 'Zephyr',
      domain: 'Zephyr.example',
    });

    expect(created.domain).toBe('zephyr.example');

    const error = await api
      .createAccount(MOCK_BRAND, { name: 'Zephyr two', domain: 'zephyr.example' })
      .catch((caught: unknown) => caught);

    expect(reasonOf(error)).toBe('domain-taken');
  });

  it('lists an account with the people filed under it', async () => {
    const api = new MockContactsApi();
    const accounts = await api.listAccounts(MOCK_BRAND, { search: 'acme' });
    const accountId = accounts.accounts[0]?.id ?? '';

    await expect(api.account(MOCK_BRAND, accountId)).resolves.toMatchObject({
      contacts: [{ id: MOCK_CONTACT_MONA }, { id: expect.any(String) }],
    });
  });

  it('renames an account', async () => {
    const api = new MockContactsApi();
    const accounts = await api.listAccounts(MOCK_BRAND, { search: 'nordwind' });
    const accountId = accounts.accounts[0]?.id ?? '';

    await expect(
      api.updateAccount(MOCK_BRAND, accountId, { name: 'Nordwind GmbH' }),
    ).resolves.toMatchObject({ name: 'Nordwind GmbH' });
  });

  it('pages, so the list footer has something to page through', async () => {
    const api = new MockContactsApi();
    const first = await api.listContacts(MOCK_BRAND, { limit: 2 });

    expect(first.contacts).toHaveLength(2);
    expect(first.nextCursor).toBe('2');

    const second = await api.listContacts(MOCK_BRAND, { limit: 2, cursor: '2' });
    expect(second.contacts).toHaveLength(2);
  });

  it('merges a pair, carries verification as it was, and undoes exactly that', async () => {
    const api = new MockContactsApi();

    const survivor = await api.mergeContacts(MOCK_BRAND, MOCK_CONTACT_MONA, {
      mergedContactId: MOCK_CONTACT_GMAIL,
    });

    expect(survivor.identities.find((row) => row.value === 'mona.k@gmail.com')?.verified).toBe(
      false,
    );
    expect(survivor.duplicates).toEqual([]);
    expect(survivor.merges).toHaveLength(1);
    await expect(api.listContacts(MOCK_BRAND)).resolves.toMatchObject({ total: 4 });
    expect((await api.contact(MOCK_BRAND, MOCK_CONTACT_GMAIL)).mergedIntoId).toBe(
      MOCK_CONTACT_MONA,
    );
    const edit = await api
      .updateContact(MOCK_BRAND, MOCK_CONTACT_GMAIL, { name: 'Edited' })
      .catch((error: unknown) => error);
    expect(reasonOf(edit)).toBe('merged');

    const mergeId = survivor.merges[0]?.id ?? '';
    const restored = await api.undoMerge(MOCK_BRAND, MOCK_CONTACT_MONA, mergeId);

    expect(restored.merges).toEqual([]);
    expect(restored.duplicates.map((row) => row.id)).toEqual([MOCK_DUPLICATE]);
    const again = await api
      .undoMerge(MOCK_BRAND, MOCK_CONTACT_MONA, mergeId)
      .catch((error: unknown) => error);
    expect(reasonOf(again)).toBe('merge-expired');
  });

  it('refuses a contact merged into itself', async () => {
    const api = new MockContactsApi();

    const merge = await api
      .mergeContacts(MOCK_BRAND, MOCK_CONTACT_MONA, { mergedContactId: MOCK_CONTACT_MONA })
      .catch((error: unknown) => error);
    const preview = await api
      .mergePreview(MOCK_BRAND, MOCK_CONTACT_MONA, MOCK_CONTACT_MONA)
      .catch((error: unknown) => error);

    expect(reasonOf(merge)).toBe('merge-self');
    expect(reasonOf(preview)).toBe('merge-self');
  });
});
