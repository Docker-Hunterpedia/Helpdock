import { type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import type { ImportRunRef } from '../jobs/claims.js';
import { ImportLoadError } from '../loader/contracts.js';

export async function requireImportPreviewRun(tx: DbTransaction, scope: ImportRunRef) {
  const [run] = await tx
    .select({
      source: importRuns.source,
      status: importRuns.status,
      pausedFrom: importRuns.pausedFrom,
    })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (
    !run ||
    !(
      ['awaiting_mapping', 'dry_run', 'ready', 'loading', 'finishing', 'completed'].includes(
        run.status,
      ) ||
      (run.status === 'paused' && run.pausedFrom !== 'extracting')
    )
  )
    throw new ImportLoadError('target-unavailable');
  return run;
}
