import { auditLog, type DbTransaction, importLog, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueImportWork } from '../import-events.js';
import { type ImportClaim, renewImportClaim } from './claims.js';

/** Release ownership and publish the next phase request in the same checkpoint transaction. */
export async function continueImportWork(
  tx: DbTransaction,
  request: {
    claim: ImportClaim;
    step: 'extract' | 'load' | 'attachments' | 'finish';
    delayMs?: number;
  },
) {
  const { claim, step } = request;
  const delay = z
    .int()
    .nonnegative()
    .parse(request.delayMs ?? 0);
  await renewImportClaim(tx, claim);
  const predicate = and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId));
  const [run] = await tx.select({ counts: importRuns.counts }).from(importRuns).where(predicate);
  if (!run) throw new Error('import.run-missing');
  const notBefore = delay ? new Date(Date.now() + delay).toISOString() : undefined;
  const { retryAt: _previous, ...counts } = run.counts;
  await tx
    .update(importRuns)
    .set({
      claimToken: null,
      claimedAt: null,
      counts: { ...counts, ...(notBefore ? { retryAt: notBefore } : {}) },
    })
    .where(predicate);
  await enqueueImportWork(tx, {
    brandId: claim.brandId,
    runId: claim.runId,
    step,
    ...(notBefore ? { notBefore } : {}),
  });
}

/** Only a still-current worker may fail a run; opaque exception text never enters the log. */
export async function failImportWork(tx: DbTransaction, claim: ImportClaim, code: string) {
  const safeCode = z
    .enum([
      'identity-ambiguous',
      'author-unmapped',
      'duplicate-source-message',
      'thread-too-large',
      'mapping-invalid',
      'target-unavailable',
      'credentials-refused',
      'invalid-response',
      'execution-failed',
      'article-preparation-required',
    ])
    .parse(code);
  await renewImportClaim(tx, claim);
  await tx
    .update(importRuns)
    .set({
      status: 'failed',
      error: safeCode,
      credentialsEncrypted: null,
      claimToken: null,
      claimedAt: null,
      finishedAt: new Date(),
    })
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
  await tx.insert(auditLog).values({
    brandId: claim.brandId,
    actorType: 'system',
    actorId: `import:${claim.runId}`,
    action: 'import.failed',
    targetType: 'import_run',
    targetId: claim.runId,
    meta: { code: safeCode },
  });
  await tx.insert(importLog).values({
    brandId: claim.brandId,
    runId: claim.runId,
    level: 'error',
    message: `import.${safeCode}`,
  });
}
