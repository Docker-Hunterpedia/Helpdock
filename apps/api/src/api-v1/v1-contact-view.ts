import {
  type ContactIdentity as ContactIdentityRow,
  type Contact as ContactRow,
  contactIdentities,
  contacts,
  type DbTransaction,
} from '@helpdock/db';
import type { V1Contact } from '@helpdock/schemas';
import { asc, inArray } from 'drizzle-orm';

/**
 * A contact as the public API and the `contact.created` webhook show it (M8):
 * who they are and how to reach them. The admin's view carries notes,
 * duplicate suggestions and merge history, which are the desk's and not an
 * integration's.
 */
export const toV1Contact = (
  contact: ContactRow,
  identities: readonly ContactIdentityRow[],
): V1Contact => ({
  id: contact.id,
  name: contact.name,
  externalId: contact.externalId,
  locale: contact.locale,
  timezone: contact.timezone,
  identities: identities.map(({ kind, value, verified }) => ({ kind, value, verified })),
  createdAt: contact.createdAt.toISOString(),
  updatedAt: contact.updatedAt.toISOString(),
});

/** The contacts with these ids, in the order given, each with its identifiers. */
export const readV1Contacts = async (
  tx: DbTransaction,
  contactIds: readonly string[],
): Promise<V1Contact[]> => {
  if (contactIds.length === 0) {
    return [];
  }
  const rows = await tx
    .select()
    .from(contacts)
    .where(inArray(contacts.id, [...contactIds]));
  const identities = await tx
    .select()
    .from(contactIdentities)
    .where(inArray(contactIdentities.contactId, [...contactIds]))
    .orderBy(asc(contactIdentities.createdAt));

  const byId = new Map(rows.map((row) => [row.id, row]));
  return contactIds.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined
      ? []
      : [
          toV1Contact(
            row,
            identities.filter((identity) => identity.contactId === id),
          ),
        ];
  });
};

export const readV1Contact = async (
  tx: DbTransaction,
  contactId: string,
): Promise<V1Contact | undefined> => (await readV1Contacts(tx, [contactId]))[0];
