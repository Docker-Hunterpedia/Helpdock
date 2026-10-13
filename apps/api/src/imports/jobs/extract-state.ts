import { type DbTransaction, importLog, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { type ImportClaim, type ImportRunRef, renewImportClaim } from './claims.js';
import { extractionRetry } from './retry-state.js';

export async function extractionRun(tx: DbTransaction, scope: ImportRunRef) {
  const [run] = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  return run;
}

export async function releaseExtraction(tx: DbTransaction, claim: ImportClaim): Promise<void> {
  await renewImportClaim(tx, claim);
  await tx
    .update(importRuns)
    .set({ claimToken: null, claimedAt: null })
    .where(eq(importRuns.id, claim.runId));
}

/** Rate-limit waits survive restarts without consuming the consecutive vendor-error budget. */
export async function deferExtraction(
  tx: DbTransaction,
  scope: {
    claim: ImportClaim;
    delayMs: number;
    code: 'import.rate-limited' | 'import.vendor-unavailable';
  },
) {
  await renewImportClaim(tx, scope.claim);
  const run = await extractionRun(tx, scope.claim);
  if (!run) throw new Error('import.run-missing');
  const previous = extractionRetry(run.counts);
  const failures =
    (previous.retryFailures ?? 0) + (scope.code === 'import.vendor-unavailable' ? 1 : 0);
  const retryAt = new Date(Date.now() + scope.delayMs);
  if (!Number.isFinite(retryAt.getTime())) throw new RangeError('Invalid import retry deadline');
  const failed = failures >= 3;
  await tx
    .update(importRuns)
    .set({
      status: failed ? 'failed' : 'extracting',
      claimToken: null,
      claimedAt: null,
      credentialsEncrypted: failed ? null : run.credentialsEncrypted,
      finishedAt: failed ? new Date() : null,
      error: failed ? 'vendor-unavailable' : null,
      counts: { ...run.counts, retryFailures: failures, retryAt: retryAt.toISOString() },
    })
    .where(eq(importRuns.id, scope.claim.runId));
  await tx.insert(importLog).values({
    brandId: scope.claim.brandId,
    runId: scope.claim.runId,
    level: failed ? 'error' : 'warning',
    message: scope.code,
  });
  return failed;
}

export async function failExtraction(
  tx: DbTransaction,
  scope: {
    claim: ImportClaim;
    code:
      | 'credentials-refused'
      | 'invalid-response'
      | 'record-unavailable'
      | 'vendor-unavailable'
      | 'execution-failed';
  },
): Promise<void> {
  await renewImportClaim(tx, scope.claim);
  await tx
    .update(importRuns)
    .set({
      status: 'failed',
      claimToken: null,
      claimedAt: null,
      credentialsEncrypted: null,
      finishedAt: new Date(),
      error: scope.code,
    })
    .where(eq(importRuns.id, scope.claim.runId));
  await tx.insert(importLog).values({
    brandId: scope.claim.brandId,
    runId: scope.claim.runId,
    level: 'error',
    message: `import.${scope.code}`,
  });
}

export async function completeExtraction(tx: DbTransaction, claim: ImportClaim): Promise<void> {
  await renewImportClaim(tx, claim);
  await tx
    .update(importRuns)
    .set({ status: 'awaiting_mapping', claimToken: null, claimedAt: null, error: null })
    .where(eq(importRuns.id, claim.runId));
}
