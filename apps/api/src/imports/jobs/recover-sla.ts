import { type DbTransaction, importRuns } from '@helpdock/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { activationState, storeActivation } from '../sla-activation.js';
import { enqueueSlaActivation } from '../sla-activation-events.js';

/** Re-publish only the persisted cursor, so losing Redis cannot duplicate already started clocks. */
export async function recoverImportedSlaActivations(tx: DbTransaction, brandId: string, now: Date) {
  const cutoff = new Date(now.getTime() - 5 * 60000).toISOString();
  const runs = await tx
    .select()
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, brandId),
        eq(importRuns.status, 'completed'),
        sql`${importRuns.options}->'slaActivation'->>'status' IN ('queued', 'running')`,
        sql`${importRuns.options}->'slaActivation'->>'updatedAt' <= ${cutoff}`,
      ),
    )
    .orderBy(asc(importRuns.id))
    .limit(100)
    .for('update');
  let count = 0;
  for (const run of runs) {
    const state = activationState(run);
    if (!state || !['queued', 'running'].includes(state.status)) continue;
    await storeActivation(tx, run, { ...state, updatedAt: now.toISOString() });
    await enqueueSlaActivation(tx, {
      brandId,
      runId: run.id,
      revision: state.revision,
      after: state.after,
    });
    count++;
  }
  return count;
}
