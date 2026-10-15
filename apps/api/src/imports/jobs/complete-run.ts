import { auditLog, type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import { HC_IMPORTED_EVENT, hcImportedPayloadSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  lockImportBrand,
  renewImportClaim,
} from './claims.js';
import { readImportFinishReadiness } from './finish-readiness.js';
import { importReportProgressSchema } from './report-window.js';

const resultSchema = z.enum(['completed', 'already_completed']);

/** Completion, the sole reindex event, audit and credential purge commit together. */
export async function completeImportRun(tx: DbTransaction, request: ImportClaim, now = new Date()) {
  const claim = importClaimSchema.parse(request);
  if (claim.phase !== 'finishing') throw new ImportClaimLost();
  await lockImportBrand(tx, claim.brandId);
  const predicate = and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId));
  const [run] = await tx.select().from(importRuns).where(predicate).for('update');
  if (!run) throw new ImportClaimLost();
  if (run.status === 'completed') return resultSchema.parse('already_completed');
  await renewImportClaim(tx, claim, now);
  const progress = importReportProgressSchema.parse(run.counts.importReports);
  const readiness = await readImportFinishReadiness(tx, claim);
  if (readiness.media_missing) throw new ImportLoadError('target-unavailable');
  if (progress.next !== null || readiness.records_pending || readiness.media_pending)
    throw new ImportLoadError('mapping-invalid');
  const [article] = await tx
    .select({ id: importRecords.id })
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, claim.brandId),
        eq(importRecords.runId, claim.runId),
        eq(importRecords.entity, 'article'),
        eq(importRecords.status, 'loaded'),
      ),
    )
    .limit(1);
  if (article && z.boolean().parse(run.counts.knowledgeChanged ?? false))
    await enqueueOutbox(tx, {
      brandId: claim.brandId,
      event: HC_IMPORTED_EVENT,
      payload: hcImportedPayloadSchema.parse({ runId: claim.runId }),
    });
  await tx
    .update(importRuns)
    .set({
      status: 'completed',
      credentialsEncrypted: null,
      claimToken: null,
      claimedAt: null,
      pausedFrom: null,
      finishedAt: now,
    })
    .where(predicate);
  await tx.insert(auditLog).values({
    brandId: claim.brandId,
    actorType: 'system',
    actorId: `import:${claim.runId}`,
    action: 'import.completed',
    targetType: 'import_run',
    targetId: claim.runId,
    meta: { source: run.source, mode: run.mode },
  });
  return resultSchema.parse('completed');
}
