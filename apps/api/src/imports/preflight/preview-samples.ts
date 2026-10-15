import { type DbTransaction, importRecords } from '@helpdock/db';
import { importPreviewSamplesSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { type ImportRunRef, importRunRefSchema, lockImportBrand } from '../jobs/claims.js';
import { requireImportPreviewRun } from './preview-run.js';

/** Stable source-ID selection, not a substitute for whole-run validation or representative acceptance datasets. */
export async function importPreviewSamples(tx: DbTransaction, raw: ImportRunRef) {
  const scope = importRunRefSchema.parse(raw);
  await lockImportBrand(tx, scope.brandId);
  await requireImportPreviewRun(tx, scope);
  const selected = async (entity: 'ticket' | 'contact') =>
    (
      await tx
        .select({ externalId: importRecords.externalId })
        .from(importRecords)
        .where(
          and(
            eq(importRecords.brandId, scope.brandId),
            eq(importRecords.runId, scope.runId),
            eq(importRecords.entity, entity),
          ),
        )
        .orderBy(importRecords.externalId)
        .limit(3)
    ).map((row) => row.externalId);
  return importPreviewSamplesSchema.parse({
    tickets: await selected('ticket'),
    contacts: await selected('contact'),
  });
}
