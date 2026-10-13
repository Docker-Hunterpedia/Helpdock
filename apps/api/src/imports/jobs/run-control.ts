import { type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import {
  type ImportRunRef,
  importPhaseSchema,
  importRunRefSchema,
  lockImportBrand,
} from './claims.js';

async function controlledRun(tx: DbTransaction, request: ImportRunRef) {
  const scope = importRunRefSchema.parse(request);
  await lockImportBrand(tx, scope.brandId);
  const [run] = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)))
    .for('update');
  return run;
}

export async function pauseImportRun(tx: DbTransaction, scope: ImportRunRef): Promise<boolean> {
  const run = await controlledRun(tx, scope);
  if (!run || !importPhaseSchema.safeParse(run.status).success) return false;
  await tx
    .update(importRuns)
    .set({ status: 'paused', pausedFrom: run.status, claimToken: null, claimedAt: null })
    .where(eq(importRuns.id, run.id));
  return true;
}

export async function resumeImportRun(
  tx: DbTransaction,
  scope: ImportRunRef,
): Promise<ReturnType<typeof importPhaseSchema.parse> | null> {
  const run = await controlledRun(tx, scope);
  if (run?.status !== 'paused' || !run.pausedFrom) return null;
  const phase = importPhaseSchema.parse(run.pausedFrom);
  await tx
    .update(importRuns)
    .set({ status: phase, pausedFrom: null })
    .where(eq(importRuns.id, run.id));
  return phase;
}

export async function cancelImportRun(
  tx: DbTransaction,
  scope: ImportRunRef,
  now = new Date(),
): Promise<boolean> {
  const run = await controlledRun(tx, scope);
  if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return false;
  await tx
    .update(importRuns)
    .set({
      status: 'cancelled',
      pausedFrom: null,
      claimToken: null,
      claimedAt: null,
      credentialsEncrypted: null,
      finishedAt: now,
    })
    .where(eq(importRuns.id, run.id));
  return true;
}
