import { type Db, type DbTransaction, importRuns, uuidv7 } from '@helpdock/db';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  importHealthOrder,
  publishImportHealthSnapshot,
  writeImportHealthBrand,
} from '../../observability/import-health.js';
import { liveBrandIds } from '../../tenant/live-brands.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { enqueueImportWork, importWorkRunnable } from '../import-events.js';
import { readBrandImportHealth } from '../import-health.js';
import { IMPORT_CLAIM_TIMEOUT_MS, lockImportBrand } from './claims.js';
import { pendingImportWorkLost, pendingImportWorkSchema } from './pending-work.js';
import { recoverImportFilePreparations } from './recover-files.js';
import { recoverImportedSlaActivations } from './recover-sla.js';

const recoveryStateSchema = pendingImportWorkSchema.extend({
  retryAt: z.iso.datetime().optional(),
});
const phases = ['extracting', 'dry_run', 'loading', 'finishing'] as const;

/**
 * Revives runs that nothing owns: no fresh claim and no live pending request. A queued request
 * gets the same lease as a claim before it counts as lost. Controls and renewals hold this brand lock.
 */
export async function recoverBrandImports(tx: DbTransaction, brandId: string, now = new Date()) {
  z.uuid().parse(brandId);
  await lockImportBrand(tx, brandId);
  const stale = new Date(now.getTime() - IMPORT_CLAIM_TIMEOUT_MS);
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
        pendingImportWorkLost(stale),
      ),
    )
    .orderBy(importRuns.createdAt, importRuns.id)
    .limit(100)
    .for('update');
  let recovered = await recoverImportFilePreparations(tx, brandId, now);
  recovered += await recoverImportedSlaActivations(tx, brandId, now);
  for (const run of runs) {
    recoveryStateSchema.parse({
      retryAt: run.counts.retryAt,
      pendingWorkId: run.counts.pendingWorkId,
      pendingWorkDueAt: run.counts.pendingWorkDueAt,
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
      .set({ claimToken: null, claimedAt: null })
      .where(and(eq(importRuns.brandId, brandId), eq(importRuns.id, run.id)));
    await enqueueImportWork(tx, { brandId, runId: run.id, step });
    recovered++;
  }
  return z.int().nonnegative().parse(recovered);
}

/** Brands are global; every tenant run read/write is inside its own audited system transaction. */
export async function recoverImportWork(
  deps: { db: Db; jobId: string; redis?: Redis },
  now = new Date(),
) {
  let recovered = 0;
  const snapshotId = deps.redis ? uuidv7() : null;
  const health: NonNullable<Awaited<ReturnType<typeof readBrandImportHealth>>>[] = [];
  let totalBrands = 0;
  let active = 0;
  let paused = 0;
  for (const brandId of await liveBrandIds(deps.db, 'active')) {
    const result = await withSystemJob(deps.db, brandId, deps.jobId, async (tx) => {
      const count = await recoverBrandImports(tx, brandId, now);
      return { count, row: deps.redis ? await readBrandImportHealth(tx, brandId) : null };
    });
    recovered += result.count;
    const row = result.row;
    if (row && deps.redis && snapshotId) {
      totalBrands++;
      active += row.active;
      paused += row.paused;
      await writeImportHealthBrand(deps.redis, snapshotId, row);
      health.push(row);
      health.sort((a, b) => {
        const left = importHealthOrder(a);
        const right = importHealthOrder(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      if (health.length > 50) health.pop();
    }
  }
  if (deps.redis && snapshotId)
    await publishImportHealthSnapshot(deps.redis, {
      configured: true,
      snapshotId,
      observedAt: now.toISOString(),
      totalBrands,
      active,
      paused,
      brands: health,
    });
  return recovered;
}
