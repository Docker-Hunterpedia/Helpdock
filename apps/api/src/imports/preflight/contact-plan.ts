import type { DbTransaction } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { matchImportedContact, validateContactAccount } from '../loader/contact-matching.js';
import { importedContactTarget } from '../loader/contact-target.js';
import { importedIdentity } from '../loader/external-ids.js';
import { type ContactLoad, contactLoadSchema } from '../loader/profile-contracts.js';
import { importedContactIdentifiers } from '../loader/profile-identities.js';

/** Same matching and merge-pointer rules as loading, with no row locks, profile changes or new IDs. */
export async function previewImportedContact(tx: DbTransaction, raw: ContactLoad) {
  const input = contactLoadSchema.parse(raw);
  const normalized = importedContactIdentifiers(input);
  const known = await importedIdentity(tx, input, 'contact', input.record.externalId);
  const knownTarget = known
    ? await importedContactTarget(tx, { brandId: input.brandId, contactId: known.helpdockId })
    : undefined;
  const payloadHash = hashImportValue({
    record: input.record,
    accountId: input.accountId,
    custom: input.custom,
    defaultCallingCode: input.defaultCallingCode,
  });
  if (knownTarget && known?.payloadHash === payloadHash)
    return {
      action: 'unchanged' as const,
      contactId: knownTarget.id,
      accountId: knownTarget.accountId,
      sourceAccountId: input.accountId,
      name: knownTarget.name,
      sourceName: input.record.name,
      identifiers: normalized.identifiers,
      refusedPhones: normalized.refusedPhones,
    };
  await validateContactAccount(tx, input);
  const matched = await matchImportedContact(tx, {
    input,
    identifiers: normalized.identifiers,
    ...(knownTarget ? { knownTarget } : {}),
    ...(known ? { originalContactId: known.helpdockId } : {}),
    readOnly: true,
  });
  return {
    action: known
      ? ('update' as const)
      : matched.existing
        ? ('link' as const)
        : ('create' as const),
    contactId: matched.existing?.id ?? null,
    accountId: matched.existing ? matched.existing.accountId : input.accountId,
    sourceAccountId: input.accountId,
    name: matched.existing?.name ?? input.record.name,
    sourceName: input.record.name,
    identifiers: normalized.identifiers,
    refusedPhones: normalized.refusedPhones,
  };
}
