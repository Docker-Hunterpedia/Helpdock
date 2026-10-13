import {
  type ContactIdentity,
  contactIdentities,
  contacts,
  type DbTransaction,
} from '@helpdock/db';
import { eq } from 'drizzle-orm';
import { importedContactValues } from './contact-values.js';
import { ImportLoadError } from './contracts.js';
import type { ContactLoad } from './profile-contracts.js';
import type { importedContactIdentifiers } from './profile-identities.js';
import { profileWarning } from './profile-warnings.js';

type IdentifierSet = ReturnType<typeof importedContactIdentifiers>;
export async function createImportedContact(
  tx: DbTransaction,
  input: ContactLoad,
  id: string,
): Promise<void> {
  await tx.insert(contacts).values({
    id,
    brandId: input.brandId,
    name: input.record.name,
    accountId: input.accountId,
    custom: input.custom,
    externalId: input.record.externalRef ?? null,
    ...importedContactValues(input),
  });
}
export async function updateImportedContactDetails(
  tx: DbTransaction,
  input: ContactLoad,
  id: string,
): Promise<void> {
  await tx
    .update(contacts)
    .set({ importedDetails: importedContactValues(input).importedDetails })
    .where(eq(contacts.id, id));
}
export async function addImportedIdentifiers(
  tx: DbTransaction,
  options: {
    input: ContactLoad;
    id: string;
    identifiers: IdentifierSet['identifiers'];
    matches: ContactIdentity[];
  },
): Promise<void> {
  for (const identity of options.identifiers) {
    if (
      options.matches.some(
        (match) => match.kind === identity.kind && match.value === identity.value,
      )
    )
      continue;
    const inserted = await tx
      .insert(contactIdentities)
      .values({
        brandId: options.input.brandId,
        contactId: options.id,
        ...identity,
        verified: false,
        source: 'import',
      })
      .onConflictDoNothing()
      .returning({ id: contactIdentities.id });
    if (!inserted.length) throw new ImportLoadError('identity-ambiguous');
  }
}
export async function importedContactWarnings(
  tx: DbTransaction,
  options: {
    input: ContactLoad;
    normalized: IdentifierSet;
    outcome: 'created' | 'updated' | 'linked';
  },
): Promise<void> {
  const { input } = options;
  const values = importedContactValues(input);
  const codes: Parameters<typeof profileWarning>[1]['message'][] = [];
  if (options.normalized.refusedPhones) codes.push('import.phone.invalid');
  if (input.record.locale && values.locale === null) codes.push('import.locale.unsupported');
  if (input.record.timezone && values.timezone === null) codes.push('import.timezone.invalid');
  if (options.outcome === 'linked') codes.push('import.identity.reused');
  for (const message of codes)
    await profileWarning(tx, {
      ...input,
      entity: 'contact',
      externalId: input.record.externalId,
      message,
    });
}
