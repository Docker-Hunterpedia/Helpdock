import { type DbTransaction, importExternalIds, importRecords } from '@helpdock/db';
import { and, eq, sql } from 'drizzle-orm';
import { validatedStagedRecord } from '../preflight/staged-record.js';
import { ImportLoadError } from './contracts.js';
import { type ImportScope, importSourceAccountKey } from './external-ids.js';

async function stagedPrimary(tx: DbTransaction, scope: ImportScope, externalId: string) {
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'article'),
        eq(importRecords.externalId, externalId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const record = validatedStagedRecord(row);
  if (record.entity !== 'article' || row.status === 'skipped' || row.helpdockId !== null)
    throw new ImportLoadError('mapping-invalid');
  return record.payload.translationOf === undefined ? record.payload : null;
}

async function ownedStagedSiblings(tx: DbTransaction, scope: ImportScope, externalId: string) {
  const accountKey = await importSourceAccountKey(tx, scope);
  return tx
    .select({ staged: importRecords, targetId: importExternalIds.helpdockId })
    .from(importRecords)
    .innerJoin(
      importExternalIds,
      and(
        eq(importExternalIds.brandId, scope.brandId),
        eq(importExternalIds.source, scope.source),
        eq(importExternalIds.sourceAccountKey, accountKey),
        eq(importExternalIds.entity, 'article'),
        eq(importExternalIds.externalId, importRecords.externalId),
      ),
    )
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'article'),
        sql`${importRecords.payload} ->> 'translationOf' = ${externalId}`,
      ),
    )
    .limit(2);
}

/** A changed source anchor can inherit an owned sibling's article, never its permission to overwrite another language. */
export async function importedArticleSiblingTarget(
  tx: DbTransaction,
  scope: ImportScope,
  externalId: string,
): Promise<string | undefined> {
  const primary = await stagedPrimary(tx, scope, externalId);
  if (!primary) return undefined;
  const siblings = await ownedStagedSiblings(tx, scope, externalId);
  if (siblings.length > 1) throw new ImportLoadError('mapping-invalid');
  const sibling = siblings[0];
  if (!sibling) return undefined;
  const record = validatedStagedRecord(sibling.staged);
  if (
    record.entity !== 'article' ||
    record.payload.translationOf !== primary.externalId ||
    record.payload.locale === primary.locale ||
    record.payload.sectionExternalId !== primary.sectionExternalId ||
    sibling.staged.status === 'skipped' ||
    (sibling.staged.helpdockId !== null && sibling.staged.helpdockId !== sibling.targetId)
  )
    throw new ImportLoadError('mapping-invalid');
  return sibling.targetId;
}
