import { type DbTransaction, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { sql } from 'drizzle-orm';
import { matchImportedContact, validateContactAccount } from './contact-matching.js';
import {
  addImportedIdentifiers,
  createImportedContact,
  importedContactWarnings,
  updateImportedContactDetails,
} from './contact-persistence.js';
import { importedContactTarget } from './contact-target.js';
import { validatedImportedCustom } from './custom-values.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { type ContactLoad, contactLoadSchema, type ProfileOutcome } from './profile-contracts.js';
import { importedContactIdentifiers } from './profile-identities.js';
import { requireLoadingRun } from './run-scope.js';

/** Identity reuse never upgrades verification, renames the local person, or creates merge suggestions. */
export async function loadImportedContact(
  tx: DbTransaction,
  request: ContactLoad,
): Promise<ProfileOutcome> {
  const input = contactLoadSchema.parse(request);
  await requireLoadingRun(tx, input);
  const normalized = importedContactIdentifiers(input);
  const lockKeys = [
    `contact:${input.source}:${input.record.externalId}`,
    ...normalized.identifiers.map((identity) => `${identity.kind}:${identity.value}`),
  ].sort();
  for (const key of lockKeys)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${key}`}, 20))`,
    );
  const known = await importedIdentity(tx, input, 'contact', input.record.externalId);
  const payloadHash = hashImportValue({
    record: input.record,
    accountId: input.accountId,
    custom: input.custom,
    defaultCallingCode: input.defaultCallingCode,
  });
  const knownTarget = known
    ? await importedContactTarget(tx, { brandId: input.brandId, contactId: known.helpdockId })
    : undefined;
  if (known?.payloadHash === payloadHash && knownTarget)
    return { id: knownTarget.id, outcome: 'unchanged' };
  await validateContactAccount(tx, input);
  const matched = await matchImportedContact(tx, {
    input,
    identifiers: normalized.identifiers,
    ...(knownTarget ? { knownTarget } : {}),
    ...(known ? { originalContactId: known.helpdockId } : {}),
  });
  input.custom = await validatedImportedCustom(tx, {
    brandId: input.brandId,
    target: 'contact',
    custom: input.custom,
    operation: matched.existing ? 'patch' : 'create',
  });
  const id = matched.existing?.id ?? uuidv7();
  const outcome = known ? 'updated' : matched.existing ? 'linked' : 'created';
  if (matched.existing) await updateImportedContactDetails(tx, input, id);
  else await createImportedContact(tx, input, id);
  await addImportedIdentifiers(tx, {
    input,
    id,
    identifiers: normalized.identifiers,
    matches: matched.matches,
  });
  await importedContactWarnings(tx, { input, normalized, outcome });
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    entity: 'contact',
    externalId: input.record.externalId,
    helpdockId: known?.helpdockId ?? id,
    payloadHash,
  });
  return { id, outcome };
}
