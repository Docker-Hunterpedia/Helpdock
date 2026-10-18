import { createHash } from 'node:crypto';
import {
  type DbTransaction,
  importFiles,
  importMappings,
  importRecords,
  importRuns,
} from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { and, eq, gt, ne, or } from 'drizzle-orm';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportRunRef, importRunRefSchema, lockImportBrand } from './claims.js';

/** Snapshot metadata only; the dry-run validator must separately verify payloads against their staged hashes. */
export async function importInputFingerprint(tx: DbTransaction, raw: ImportRunRef) {
  const scope = importRunRefSchema.parse(raw);
  await lockImportBrand(tx, scope.brandId);
  const [run] = await tx
    .select({
      source: importRuns.source,
      account: importRuns.sourceAccountKey,
      mode: importRuns.mode,
      parent: importRuns.parentRunId,
      options: importRuns.options,
    })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run) throw new ImportLoadError('target-unavailable');
  // Revision 2 requires article media to be reviewed too; an attachment-only approval cannot authorize it.
  const digest = createHash('sha256').update(hashImportValue({ version: 2, ...scope, ...run }));
  const files = await tx
    .select({
      id: importFiles.id,
      revision: importFiles.revision,
      sourceKey: importFiles.sourceKey,
      sha256: importFiles.sha256,
      format: importFiles.format,
      entity: importFiles.entity,
      mapping: importFiles.mapping,
      inventoryMapping: importFiles.inventoryMapping,
      inventoryValidation: importFiles.inventoryValidation,
    })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.brandId, scope.brandId),
        eq(importFiles.runId, scope.runId),
        ne(importFiles.status, 'discarded'),
      ),
    )
    .orderBy(importFiles.id)
    .limit(101);
  if (files.length > 100) throw new ImportLoadError('mapping-invalid');
  for (const file of files) digest.update(hashImportValue({ type: 'source-file', ...file }));
  let recordAfter: Pick<typeof importRecords.$inferSelect, 'entity' | 'externalId'> | undefined;
  while (true) {
    const rows = await tx
      .select({
        id: importRecords.id,
        entity: importRecords.entity,
        externalId: importRecords.externalId,
        parent: importRecords.parentExternalId,
        hash: importRecords.payloadHash,
        status: importRecords.status,
      })
      .from(importRecords)
      .where(
        and(
          eq(importRecords.brandId, scope.brandId),
          eq(importRecords.runId, scope.runId),
          recordAfter
            ? or(
                gt(importRecords.entity, recordAfter.entity),
                and(
                  eq(importRecords.entity, recordAfter.entity),
                  gt(importRecords.externalId, recordAfter.externalId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(importRecords.entity, importRecords.externalId)
      .limit(500);
    for (const row of rows) digest.update(hashImportValue({ type: 'record', ...row }));
    const last = rows.at(-1);
    if (!last) break;
    recordAfter = last;
  }
  let mappingAfter: Pick<typeof importMappings.$inferSelect, 'kind' | 'externalValue'> | undefined;
  while (true) {
    const rows = await tx
      .select({
        id: importMappings.id,
        kind: importMappings.kind,
        externalValue: importMappings.externalValue,
        target: importMappings.target,
      })
      .from(importMappings)
      .where(
        and(
          eq(importMappings.brandId, scope.brandId),
          eq(importMappings.runId, scope.runId),
          mappingAfter
            ? or(
                gt(importMappings.kind, mappingAfter.kind),
                and(
                  eq(importMappings.kind, mappingAfter.kind),
                  gt(importMappings.externalValue, mappingAfter.externalValue),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(importMappings.kind, importMappings.externalValue)
      .limit(500);
    for (const row of rows) digest.update(hashImportValue({ type: 'mapping', ...row }));
    const last = rows.at(-1);
    if (!last) break;
    mappingAfter = last;
  }
  return digest.digest('hex');
}
