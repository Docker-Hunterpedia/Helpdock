import { type Db, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportClaimLost, importClaimSchema } from './claims.js';
import { completeImportRun } from './complete-run.js';
import { rebuildImportReportsBatch } from './rebuild-reports.js';

const resultSchema = z.strictObject({
  state: z.enum(['more', 'completed', 'already_completed', 'stopped']),
});

/** One report chunk per invocation; the last chunk shares the terminal completion transaction. */
export async function runImportFinishBatch(
  deps: { db: Db; jobId: string },
  request: z.infer<typeof importClaimSchema>,
  now = new Date(),
) {
  const claim = importClaimSchema.parse(request);
  if (claim.phase !== 'finishing') throw new ImportClaimLost();
  try {
    return await withSystemJob(deps.db, claim.brandId, deps.jobId, async (tx) => {
      const [run] = await tx
        .select({ status: importRuns.status })
        .from(importRuns)
        .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
      if (run?.status !== 'completed') {
        const reports = await rebuildImportReportsBatch(tx, claim, now);
        if (reports.state === 'more') return resultSchema.parse({ state: 'more' });
      }
      return resultSchema.parse({ state: await completeImportRun(tx, claim, now) });
    });
  } catch (error) {
    if (!(error instanceof ImportClaimLost)) throw error;
    return resultSchema.parse({ state: 'stopped' });
  }
}
