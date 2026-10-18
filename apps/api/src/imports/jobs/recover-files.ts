import { type DbTransaction, importFiles, importRuns } from '@helpdock/db';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { enqueueImportFilePreparation } from '../file-events.js';
import { importFilePreparationSource } from './file-preparation-state.js';

/** BullMQ handles ordinary redelivery; this also recovers exhausted preparations after a cooldown. */
export async function recoverImportFilePreparations(tx: DbTransaction, brandId: string, now: Date) {
  const stale = new Date(now.getTime() - 60 * 60 * 1000);
  const files = await tx
    .select({ file: importFiles })
    .from(importFiles)
    .innerJoin(
      importRuns,
      and(eq(importRuns.id, importFiles.runId), eq(importRuns.brandId, importFiles.brandId)),
    )
    .where(
      and(
        eq(importFiles.brandId, brandId),
        importFilePreparationSource(),
        inArray(importRuns.status, ['draft', 'connecting']),
        lt(importFiles.updatedAt, stale),
        or(
          eq(importFiles.status, 'uploaded'),
          and(
            eq(importFiles.status, 'ready'),
            or(
              and(isNotNull(importFiles.mapping), isNull(importFiles.validation)),
              and(
                isNotNull(importFiles.inventoryMapping),
                isNull(importFiles.inventoryValidation),
                sql`${importFiles.inventoryMapping}->>'idColumn' IS NOT NULL`,
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(importFiles.updatedAt), asc(importFiles.id))
    .limit(100)
    .for('update', { of: importFiles });
  for (const { file } of files) {
    await tx.update(importFiles).set({ updatedAt: now }).where(eq(importFiles.id, file.id));
    await enqueueImportFilePreparation(tx, {
      brandId,
      runId: file.runId,
      fileId: file.id,
      revision: file.revision,
    });
  }
  return files.length;
}
