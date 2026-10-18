import { brands, type DbTransaction, importFiles, importRuns } from '@helpdock/db';
import type { importFilePrepareJob } from '@helpdock/jobs';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { TICKET_INVENTORY_SOURCES } from '../sources.js';
import { lockImportBrand } from './claims.js';

export function importFilePreparationSource() {
  return or(
    and(eq(importRuns.source, 'file'), isNull(importFiles.inventoryMapping)),
    and(
      inArray(importRuns.source, [...TICKET_INVENTORY_SOURCES]),
      isNotNull(importFiles.inventoryMapping),
      eq(importFiles.format, 'csv'),
      eq(importFiles.entity, 'ticket'),
    ),
  );
}

/** Revalidate run, brand and revision before every bounded preparation write. */
export async function availableImportSourceFile(
  tx: DbTransaction,
  input: z.infer<typeof importFilePrepareJob.schema>,
) {
  await lockImportBrand(tx, input.brandId);
  const [row] = await tx
    .select({ file: importFiles, source: importRuns.source })
    .from(importFiles)
    .innerJoin(
      importRuns,
      and(eq(importRuns.id, importFiles.runId), eq(importRuns.brandId, importFiles.brandId)),
    )
    .innerJoin(brands, eq(brands.id, importFiles.brandId))
    .where(
      and(
        eq(importFiles.brandId, input.brandId),
        eq(importFiles.runId, input.runId),
        eq(importFiles.id, input.fileId),
        eq(importFiles.revision, input.revision),
        inArray(importFiles.status, ['uploaded', 'ready']),
        inArray(importRuns.status, ['draft', 'connecting']),
        importFilePreparationSource(),
        eq(brands.status, 'active'),
      ),
    )
    .for('update', { of: importFiles });
  return row ? { ...row.file, source: row.source } : undefined;
}
