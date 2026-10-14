import { accounts, type DbTransaction, importRecords } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportScope, importedIdentity } from '../loader/external-ids.js';
import type { ContactLoad } from '../loader/profile-contracts.js';
import { previewImportedContact } from './contact-plan.js';
import { previewImportedCustom } from './custom-values.js';
import { previewImportedOrganization } from './organization-plan.js';
import { validatedStagedRecord } from './staged-record.js';

async function sourceOrganizationPlan(tx: DbTransaction, scope: ImportScope, externalId: string) {
  const [staged] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'organization'),
        eq(importRecords.externalId, externalId),
      ),
    );
  if (!staged) {
    const known = await importedIdentity(tx, scope, 'organization', externalId);
    if (!known) throw new ImportLoadError('target-unavailable');
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.brandId, scope.brandId), eq(accounts.id, known.helpdockId)));
    if (!account) throw new ImportLoadError('target-unavailable');
    return { action: 'reuse' as const, accountId: account.id, name: account.name, externalId };
  }
  const native = validatedStagedRecord(staged);
  if (native.entity !== 'organization') throw new ImportLoadError('mapping-invalid');
  const custom = await previewImportedCustom(tx, {
    ...scope,
    target: 'account',
    custom: native.payload.custom,
    operation: 'patch',
  });
  const plan = await previewImportedOrganization(tx, { ...scope, record: native.payload, custom });
  if (plan.action === 'create')
    await previewImportedCustom(tx, {
      ...scope,
      target: 'account',
      custom: native.payload.custom,
      operation: 'create',
    });
  return { ...plan, externalId };
}

/** A proposed company has no ID yet; keep its source plan separate from the local profile. */
export async function previewImportedContactSource(
  tx: DbTransaction,
  request: ImportScope & { record: ContactLoad['record']; defaultCallingCode: string },
) {
  const { record, defaultCallingCode, ...scope } = request;
  const organization = record.organizationExternalId
    ? await sourceOrganizationPlan(tx, scope, record.organizationExternalId)
    : null;
  const custom = await previewImportedCustom(tx, {
    ...scope,
    target: 'contact',
    custom: record.custom,
    operation: 'patch',
  });
  const contact = await previewImportedContact(tx, {
    ...scope,
    record,
    defaultCallingCode,
    custom,
    accountId: organization?.accountId ?? null,
  });
  if (contact.action === 'create')
    await previewImportedCustom(tx, {
      ...scope,
      target: 'contact',
      custom: record.custom,
      operation: 'create',
    });
  return { ...contact, organization };
}
