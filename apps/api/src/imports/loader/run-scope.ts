import { brands, type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';
import type { ImportScope } from './external-ids.js';
export type ImportRunScope = ImportScope & { runId: string };

export async function requireLoadingRun(tx: DbTransaction, scope: ImportRunScope): Promise<void> {
  const [run] = await tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .innerJoin(brands, eq(brands.id, importRuns.brandId))
    .where(
      and(
        eq(importRuns.id, scope.runId),
        eq(importRuns.brandId, scope.brandId),
        eq(importRuns.source, scope.source),
        eq(importRuns.status, 'loading'),
        eq(brands.status, 'active'),
      ),
    );
  if (!run) throw new ImportLoadError('mapping-invalid');
}
