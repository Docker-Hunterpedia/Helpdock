import { accounts, type DbTransaction, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { and, eq, sql } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';
import { validatedImportedCustom } from './custom-values.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { importedOrganizationDomains, matchImportedOrganization } from './organization-matching.js';
import {
  type OrganizationLoad,
  organizationLoadSchema,
  type ProfileOutcome,
} from './profile-contracts.js';
import { profileWarning } from './profile-warnings.js';
import { requireLoadingRun } from './run-scope.js';

/** Does not merge accounts or rename an existing local company. */
export async function loadImportedOrganization(
  tx: DbTransaction,
  request: OrganizationLoad,
): Promise<ProfileOutcome> {
  const input = organizationLoadSchema.parse(request);
  await requireLoadingRun(tx, input);
  const domains = importedOrganizationDomains(input.record);
  const lockKeys = [
    `organization:${input.record.externalId}`,
    ...domains.map((domain) => `domain:${domain}`),
  ].sort();
  for (const key of lockKeys)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${key}`}, 19))`,
    );
  const known = await importedIdentity(tx, input, 'organization', input.record.externalId);
  const payloadHash = hashImportValue({ record: input.record, custom: input.custom });
  const [knownAccount] = known
    ? await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.brandId, input.brandId), eq(accounts.id, known.helpdockId)))
    : [];
  if (known && !knownAccount) throw new ImportLoadError('target-unavailable');
  if (known?.payloadHash === payloadHash) return { id: known.helpdockId, outcome: 'unchanged' };
  const linked = await matchImportedOrganization(tx, input, domains, known?.helpdockId);
  input.custom = await validatedImportedCustom(tx, {
    brandId: input.brandId,
    target: 'account',
    custom: input.custom,
    operation: linked ? 'patch' : 'create',
  });
  const id = linked?.id ?? uuidv7();
  const importedDetails = {
    ...linked?.importedDetails,
    domains: [...new Set([...(linked?.importedDetails?.domains ?? []), ...domains])],
    notes: input.record.notes ?? linked?.importedDetails?.notes ?? null,
    ...(input.record.description === undefined ? {} : { description: input.record.description }),
    ...(input.record.createdAt === undefined ? {} : { createdAt: input.record.createdAt }),
    ...(input.record.updatedAt === undefined ? {} : { updatedAt: input.record.updatedAt }),
  };
  if (linked) {
    await tx.update(accounts).set({ importedDetails }).where(eq(accounts.id, id));
    if (!known)
      await profileWarning(tx, {
        ...input,
        entity: 'organization',
        externalId: input.record.externalId,
        message: 'import.organization.reused',
      });
  } else
    await tx.insert(accounts).values({
      id,
      brandId: input.brandId,
      name: input.record.name,
      domain: domains[0] ?? null,
      custom: input.custom,
      importedDetails,
      ...(input.record.createdAt === undefined
        ? {}
        : { createdAt: new Date(input.record.createdAt) }),
      ...(input.record.updatedAt === undefined || input.record.createdAt === undefined
        ? {}
        : { updatedAt: new Date(input.record.updatedAt) }),
    });
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    runId: input.runId,
    entity: 'organization',
    externalId: input.record.externalId,
    helpdockId: id,
    payloadHash,
  });
  return { id, outcome: known ? 'updated' : linked ? 'linked' : 'created' };
}
