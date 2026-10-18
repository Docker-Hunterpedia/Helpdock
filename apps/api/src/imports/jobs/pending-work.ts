import { type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * A run is owned either by one claim or by one pending request, never both. The marker names the
 * outbox row of that request, so an older or duplicate delivery recognises itself and exits.
 */
export const pendingImportWorkSchema = z.strictObject({
  pendingWorkId: z.uuid().optional(),
  pendingWorkDueAt: z.iso.datetime().optional(),
});

export async function markPendingImportWork(
  tx: DbTransaction,
  request: { brandId: string; runId: string; workId: string; dueAt: string },
) {
  const marker = pendingImportWorkSchema.required().parse({
    pendingWorkId: request.workId,
    pendingWorkDueAt: request.dueAt,
  });
  await tx
    .update(importRuns)
    .set({ counts: sql`${importRuns.counts} || ${JSON.stringify(marker)}::jsonb` })
    .where(and(eq(importRuns.brandId, request.brandId), eq(importRuns.id, request.runId)));
}

/** Taking a claim consumes the pending request; the claim holder now owns the next handoff. */
export const countsWithoutPendingImportWork = (): SQL =>
  sql`${importRuns.counts} - 'pendingWorkId' - 'pendingWorkDueAt'`;

export const isPendingImportWork = (workId: string): SQL =>
  sql`${importRuns.counts}->>'pendingWorkId' = ${workId}`;

/**
 * A request still in the outbox is never lost: the relay keeps retrying it. One that left the
 * outbox but has not started by `lostBefore` is presumed dropped by the queue.
 */
export const pendingImportWorkLost = (lostBefore: Date): SQL =>
  sql`(${importRuns.counts}->>'pendingWorkDueAt' IS NULL OR (
    (${importRuns.counts}->>'pendingWorkDueAt')::timestamptz <= ${lostBefore.toISOString()}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM outbox pending
      WHERE pending.id::text = ${importRuns.counts}->>'pendingWorkId' AND pending.published_at IS NULL)))`;
