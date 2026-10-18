import {
  type DbTransaction,
  importFiles,
  importLog,
  importMappings,
  importRecords,
  importRuns,
  importTicketInventory,
} from '@helpdock/db';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { purgeImportedArticleAssetsBatch } from './article-asset-retention.js';
import { purgeImportFileKeys } from './file-cleanup.js';
import { lockImportBrand } from './jobs/claims.js';

export const IMPORT_STAGING_RETENTION_DAYS = 30;
const requestSchema = z.strictObject({
  brandId: z.uuid(),
  now: z.date(),
  limit: z.int().min(1).max(1000),
});

/** Rows and object-cleanup events commit together; run summaries and native-ID receipts remain. */
export async function purgeImportStagingBatch(
  tx: DbTransaction,
  raw: z.infer<typeof requestSchema>,
) {
  const { brandId, now, limit } = requestSchema.parse(raw);
  await lockImportBrand(tx, brandId);
  const cutoff = new Date(now.getTime() - IMPORT_STAGING_RETENTION_DAYS * 86400000);
  const removedAssets = await purgeImportedArticleAssetsBatch(tx, { brandId, cutoff, limit });
  if (removedAssets === limit) return removedAssets;
  const expiredRuns = tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, brandId),
        inArray(importRuns.status, ['completed', 'failed', 'cancelled']),
        lt(importRuns.finishedAt, cutoff),
      ),
    );
  const expiredFiles = and(
    eq(importFiles.brandId, brandId),
    or(
      inArray(importFiles.runId, expiredRuns),
      and(eq(importFiles.status, 'discarded'), lt(importFiles.updatedAt, cutoff)),
    ),
  );
  const inventoryIds = tx
    .select({ id: importTicketInventory.id })
    .from(importTicketInventory)
    .where(
      and(
        eq(importTicketInventory.brandId, brandId),
        inArray(
          importTicketInventory.fileId,
          tx.select({ id: importFiles.id }).from(importFiles).where(expiredFiles),
        ),
      ),
    )
    .orderBy(importTicketInventory.id)
    .limit(limit - removedAssets);
  const purgedInventory = await tx
    .delete(importTicketInventory)
    .where(
      and(
        eq(importTicketInventory.brandId, brandId),
        inArray(importTicketInventory.id, inventoryIds),
      ),
    )
    .returning({ id: importTicketInventory.id });
  let removed = removedAssets + purgedInventory.length;
  if (removed === limit) return removed;
  const files = await tx
    .select({
      id: importFiles.id,
      upload: importFiles.uploadKey,
      source: importFiles.sourceKey,
      preparation: importFiles.preparationKey,
    })
    .from(importFiles)
    .where(
      and(
        expiredFiles,
        sql`NOT EXISTS (SELECT 1 FROM ${importTicketInventory}
        WHERE ${importTicketInventory.fileId} = ${importFiles.id})`,
      ),
    )
    .orderBy(asc(importFiles.id))
    .limit(limit - removed)
    .for('update');
  removed += files.length;
  if (files.length) {
    await purgeImportFileKeys(
      tx,
      brandId,
      files.flatMap((file) => [file.upload, file.source, file.preparation]),
    );
    await tx.delete(importFiles).where(
      and(
        eq(importFiles.brandId, brandId),
        inArray(
          importFiles.id,
          files.map((file) => file.id),
        ),
      ),
    );
  }
  for (const table of [importRecords, importMappings, importLog]) {
    if (removed === limit) break;
    const ids = tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.brandId, brandId), inArray(table.runId, expiredRuns)))
      .orderBy(asc(table.id))
      .limit(limit - removed);
    const rows = await tx
      .delete(table)
      .where(and(eq(table.brandId, brandId), inArray(table.id, ids)))
      .returning({ id: table.id });
    removed += rows.length;
  }
  return removed;
}
