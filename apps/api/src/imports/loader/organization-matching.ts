import { accounts, type DbTransaction } from '@helpdock/db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';
import type { OrganizationLoad } from './profile-contracts.js';

export function importedOrganizationDomains(record: OrganizationLoad['record']): string[] {
  return [...new Set(record.domains.map((domain) => domain.trim().toLowerCase()))].filter(
    (domain) => domain !== '',
  );
}

/** Read-only matching shared by preflight and loading; local companies are never merged. */
export async function matchImportedOrganization(
  tx: DbTransaction,
  input: OrganizationLoad,
  domains: string[],
  knownId?: string,
) {
  const [known] = knownId
    ? await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.brandId, input.brandId), eq(accounts.id, knownId)))
    : [];
  if (knownId && !known) throw new ImportLoadError('target-unavailable');
  const matches = domains.length
    ? await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.brandId, input.brandId),
            or(
              inArray(accounts.domain, domains),
              sql`(${accounts.importedDetails}->'domains') ?| ARRAY[${sql.join(
                domains.map((domain) => sql`${domain}`),
                sql`, `,
              )}]::text[]`,
            ),
          ),
        )
    : [];
  if (new Set(matches.map((account) => account.id)).size > 1)
    throw new ImportLoadError('identity-ambiguous');
  const linked = known ?? matches[0];
  if (linked && matches.some((account) => account.id !== linked.id))
    throw new ImportLoadError('identity-ambiguous');
  return linked;
}
