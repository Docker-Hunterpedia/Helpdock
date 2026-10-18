import { accounts, type DbTransaction } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from '../loader/contracts.js';
import { importedIdentity } from '../loader/external-ids.js';
import {
  importedOrganizationDomains,
  matchImportedOrganization,
} from '../loader/organization-matching.js';
import { type OrganizationLoad, organizationLoadSchema } from '../loader/profile-contracts.js';

/** No ID allocation or company writes; preserve local name and expose the separate source name. */
export async function previewImportedOrganization(tx: DbTransaction, raw: OrganizationLoad) {
  const input = organizationLoadSchema.parse(raw);
  const domains = importedOrganizationDomains(input.record);
  const known = await importedIdentity(tx, input, 'organization', input.record.externalId);
  const hash = hashImportValue({ record: input.record, custom: input.custom });
  if (known?.payloadHash === hash) {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.brandId, input.brandId), eq(accounts.id, known.helpdockId)));
    if (!account) throw new ImportLoadError('target-unavailable');
    return {
      action: 'unchanged' as const,
      accountId: account.id,
      name: account.name,
      sourceName: input.record.name,
      domains,
    };
  }
  const linked = await matchImportedOrganization(tx, input, domains, known?.helpdockId);
  return {
    action: known ? ('update' as const) : linked ? ('link' as const) : ('create' as const),
    accountId: linked?.id ?? null,
    name: linked?.name ?? input.record.name,
    sourceName: input.record.name,
    domains,
  };
}
