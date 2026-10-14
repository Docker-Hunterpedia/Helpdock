import { type DbTransaction, importRuns } from '@helpdock/db';
import { type ImportEntity, importEntitySchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ImportClaim, ImportClaimLost } from './claims.js';

/** The caller commits the staged receipt in this transaction before incrementing progress. */
export async function recordLoadProgress(
  tx: DbTransaction,
  request: {
    claim: ImportClaim;
    entity: ImportEntity;
    status: 'loaded' | 'skipped';
    knowledgeChanged?: boolean;
  },
) {
  const { claim, entity, status, knowledgeChanged } = request;
  const predicate = and(eq(importRuns.id, claim.runId), eq(importRuns.brandId, claim.brandId));
  const [run] = await tx.select({ counts: importRuns.counts }).from(importRuns).where(predicate);
  if (!run) throw new ImportClaimLost();
  const counts = z
    .partialRecord(importEntitySchema, z.int().nonnegative())
    .parse(run.counts[status] ?? {});
  counts[entity] = (counts[entity] ?? 0) + 1;
  await tx
    .update(importRuns)
    .set({
      counts: {
        ...run.counts,
        [status]: counts,
        ...(knowledgeChanged ? { knowledgeChanged: true } : {}),
      },
    })
    .where(predicate);
}
