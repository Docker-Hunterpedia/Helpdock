import { auditLog, type Db, importRuns } from '@helpdock/db';
import type { Connector, ConnectorContext } from '@helpdock/importers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { type ImportClaim, type ImportRunRef, renewImportClaim } from './claims.js';
import { runImportDryRunMediaBatch } from './dry-run-media.js';
import { runImportDryRunRecordBatch } from './dry-run-records.js';
import { importDryRunCheckpointSchema, storeImportDryRunCheckpoint } from './dry-run-state.js';
import { extractionRun } from './extract-state.js';
import { importInputFingerprint } from './input-fingerprint.js';

/** Validation ends at review; it cannot authorize domain writes or start loading. */
async function completeDryRun(deps: { db: Db; jobId: string }, claim: ImportClaim) {
  return withSystemJob(deps.db, claim.brandId, deps.jobId, async (tx) => {
    await renewImportClaim(tx, claim);
    const run = await extractionRun(tx, claim);
    const checkpoint = importDryRunCheckpointSchema.parse(run?.dryRunReport);
    if (
      (await importInputFingerprint(tx, { brandId: claim.brandId, runId: claim.runId })) !==
      checkpoint.fingerprint
    ) {
      await storeImportDryRunCheckpoint(tx, claim, { ...checkpoint, phase: 'invalidated' });
      return { state: 'invalidated' as const };
    }
    await tx
      .update(importRuns)
      .set({ status: 'awaiting_mapping', claimToken: null, claimedAt: null })
      .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
    await tx.insert(auditLog).values({
      brandId: claim.brandId,
      actorType: 'system',
      actorId: `import:${claim.runId}`,
      action: 'import.dry-run-completed',
      targetType: 'import_run',
      targetId: claim.runId,
      meta: {
        checked: checkpoint.checked,
        errors:
          checkpoint.issueCount +
          checkpoint.planIssueCount +
          checkpoint.identityIssueCount +
          checkpoint.mediaErrors,
        warnings: checkpoint.mediaWarnings + checkpoint.recordWarningCount,
        refusedPhones: checkpoint.refusedPhones,
      },
    });
    return { state: 'completed' as const };
  });
}

/** Each queue delivery does one bounded scan or media operation and checkpoints before yielding. */
export async function runImportDryRunBatch<C>(
  deps: {
    db: Db;
    jobId: string;
    resolve(
      scope: ImportRunRef,
    ): Promise<{ connector: Connector<C>; context: ConnectorContext<C> }>;
  },
  claim: ImportClaim,
) {
  const scope = { brandId: claim.brandId, runId: claim.runId };
  const checkpoint = await withSystemJob(deps.db, claim.brandId, deps.jobId, async (tx) => {
    await renewImportClaim(tx, claim);
    const run = await extractionRun(tx, claim);
    // The record scanner invalidates legacy checkpoints instead of treating them as vendor failures.
    if (z.object({ version: z.literal(1) }).safeParse(run?.dryRunReport).success) return null;
    return run?.dryRunReport ? importDryRunCheckpointSchema.parse(run.dryRunReport) : null;
  });
  const phase = checkpoint?.phase;
  if (phase === 'identities_checked' || phase === 'media_checked') {
    const media = await runImportDryRunMediaBatch(
      { ...deps, ...(await deps.resolve(scope)) },
      claim,
    );
    if (media.state === 'media_checked') return completeDryRun(deps, claim);
    return media;
  }
  const records = await runImportDryRunRecordBatch(deps, {
    claim,
    defaultCallingCode: checkpoint?.defaultCallingCode ?? '',
  });
  return records.state === 'stopped' || records.state === 'invalidated'
    ? records
    : { state: 'more' as const };
}
