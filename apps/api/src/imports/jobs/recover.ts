import { type Db, type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { liveBrandIds } from '../../tenant/live-brands.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { enqueueImportWork, importWorkRunnable } from '../import-events.js';
import { IMPORT_CLAIM_TIMEOUT_MS, lockImportBrand } from './claims.js';

const recoveryTimesSchema = z.strictObject({
  retryAt: z.iso.datetime().optional(),
  recoveryRequestedAt: z.iso.datetime().optional(),
});
const phases = ['extracting', 'dry_run', 'loading', 'finishing'] as const;
const RECOVERY_COOLDOWN_MS = 60000;

/** A fresh claim cannot be cleared by recovery; controls and renewals hold this same brand lock. */
export async function recoverBrandImports(tx: DbTransaction, brandId: string, now = new Date()) {
  z.uuid().parse(brandId);
  await lockImportBrand(tx, brandId);
  const stale = new Date(now.getTime() - IMPORT_CLAIM_TIMEOUT_MS);
  const cooldown = new Date(now.getTime() - RECOVERY_COOLDOWN_MS).toISOString();
  const runs = await tx
    .select()
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, brandId),
        inArray(importRuns.status, [...phases]),
        ne(importRuns.sourceAccountKey, '0'.repeat(64)),
        or(isNull(importRuns.claimToken), lt(importRuns.claimedAt, stale)),
        sql`(${importRuns.counts}->>'retryAt' IS NULL OR ${importRuns.counts}->>'retryAt' <= ${now.toISOString()})`,
        sql`(${importRuns.counts}->>'recoveryRequestedAt' IS NULL OR ${importRuns.counts}->>'recoveryRequestedAt' <= ${cooldown})`,
      ),
    )
    .orderBy(importRuns.createdAt, importRuns.id)
    .limit(100)
    .for('update');
  let recovered = 0;
  for (const run of runs) {
    recoveryTimesSchema.parse({
      retryAt: run.counts.retryAt,
      recoveryRequestedAt: run.counts.recoveryRequestedAt,
    });
    const step =
      run.status === 'extracting'
        ? 'extract'
        : run.status === 'dry_run'
          ? 'dry_run'
          : run.status === 'finishing'
            ? 'finish'
            : 'load';
    if (!(await importWorkRunnable(tx, brandId, run.id, step))) continue;
    await tx
      .update(importRuns)
      .set({
        claimToken: null,
        claimedAt: null,
        counts: { ...run.counts, recoveryRequestedAt: now.toISOString() },
      })
      .where(and(eq(importRuns.brandId, brandId), eq(importRuns.id, run.id)));
    await enqueueImportWork(tx, { brandId, runId: run.id, step });
    recovered++;
  }
  return z.int().nonnegative().parse(recovered);
}

/** Brands are global; every tenant run read/write is inside its own audited system transaction. */
export async function recoverImportWork(deps: { db: Db; jobId: string }, now = new Date()) {
  let recovered = 0;
  for (const brandId of await liveBrandIds(deps.db, 'active')) {
    recovered += await withSystemJob(deps.db, brandId, deps.jobId, (tx) =>
      recoverBrandImports(tx, brandId, now),
    );
  }
  return recovered;
}
