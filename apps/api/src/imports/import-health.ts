import { brands, type DbTransaction, importLog, importRuns } from '@helpdock/db';
import { importBrandHealthSchema } from '@helpdock/schemas';
import { and, count, desc, eq } from 'drizzle-orm';

/** Called only in a single-brand audited worker transaction; install routes never query these tenant tables. */
export async function readBrandImportHealth(tx: DbTransaction, brandId: string) {
  const groups = await tx
    .select({ status: importRuns.status, total: count() })
    .from(importRuns)
    .where(eq(importRuns.brandId, brandId))
    .groupBy(importRuns.status);
  if (!groups.length) return null;
  const [brand] = await tx.select({ name: brands.name }).from(brands).where(eq(brands.id, brandId));
  if (!brand) return null;
  const [error] = await tx
    .select({
      runId: importRuns.id,
      source: importRuns.source,
      at: importLog.at,
      code: importLog.message,
    })
    .from(importLog)
    .innerJoin(
      importRuns,
      and(eq(importRuns.brandId, importLog.brandId), eq(importRuns.id, importLog.runId)),
    )
    .where(and(eq(importLog.brandId, brandId), eq(importLog.level, 'error')))
    .orderBy(desc(importLog.id))
    .limit(1);
  const active = groups
    .filter((row) => ['extracting', 'dry_run', 'loading', 'finishing'].includes(row.status))
    .reduce((sum, row) => sum + row.total, 0);
  const code =
    error && /^import\.[a-z0-9_.:-]{1,93}$/.test(error.code)
      ? error.code
      : 'import.execution-failed';
  return importBrandHealthSchema.parse({
    brandId,
    brandName: brand.name,
    active,
    paused: groups.find((row) => row.status === 'paused')?.total ?? 0,
    lastError: error ? { ...error, at: error.at.toISOString(), code } : null,
  });
}
