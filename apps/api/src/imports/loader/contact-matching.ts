import {
  accounts,
  type Contact,
  contactIdentities,
  contacts,
  type DbTransaction,
} from '@helpdock/db';
import { and, eq, or } from 'drizzle-orm';
import { importedContactTarget } from './contact-target.js';
import { ImportLoadError } from './contracts.js';
import type { ContactLoad } from './profile-contracts.js';
import type { importedContactIdentifiers } from './profile-identities.js';

type Identifiers = ReturnType<typeof importedContactIdentifiers>['identifiers'];
export async function validateContactAccount(tx: DbTransaction, input: ContactLoad): Promise<void> {
  if (!input.accountId) return;
  const [account] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.brandId, input.brandId)));
  if (!account) throw new ImportLoadError('mapping-invalid');
}

export async function matchImportedContact(
  tx: DbTransaction,
  options: {
    input: ContactLoad;
    identifiers: Identifiers;
    knownTarget?: Contact;
    originalContactId?: string;
    readOnly?: boolean;
  },
) {
  const { input, identifiers } = options;
  const matches = identifiers.length
    ? await tx
        .select()
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.brandId, input.brandId),
            or(
              ...identifiers.map((identity) =>
                and(
                  eq(contactIdentities.kind, identity.kind),
                  eq(contactIdentities.value, identity.value),
                ),
              ),
            ),
          ),
        )
    : [];
  const candidates = new Set(matches.map((identity) => identity.contactId));
  if (options.knownTarget) candidates.add(options.knownTarget.id);
  if (candidates.size > 1) throw new ImportLoadError('identity-ambiguous');
  const existingId = [...candidates][0];
  let existing: Contact | undefined;
  if (existingId) {
    const query = tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, existingId), eq(contacts.brandId, input.brandId)));
    [existing] = await (options.readOnly ? query : query.for('update'));
  }
  if (existingId && (!existing || existing.anonymisedAt || existing.mergedIntoId))
    throw new ImportLoadError('target-unavailable');
  if (
    options.originalContactId &&
    existing &&
    (
      await importedContactTarget(tx, {
        brandId: input.brandId,
        contactId: options.originalContactId,
      })
    ).id !== existing.id
  )
    throw new ImportLoadError('target-unavailable');
  return { existing, matches };
}
