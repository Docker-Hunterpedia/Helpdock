import { type DbTransaction, importRuns, ticketStatuses, tickets } from '@helpdock/db';
import {
  importSlaActivationSchema,
  importSlaActivationStateSchema,
  importSlaOverviewSchema,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { and, count, eq, gt, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ImportRunRef } from './jobs/claims.js';

export type ActivationState = z.infer<typeof importSlaActivationStateSchema>;
export type ActivationRun = typeof importRuns.$inferSelect;

export function activationState(run: ActivationRun): ActivationState | null {
  return run.options.slaActivation === undefined
    ? null
    : importSlaActivationStateSchema.parse(run.options.slaActivation);
}

export async function activationRun(tx: DbTransaction, scope: ImportRunRef) {
  const [run] = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run) throw new NotFoundException('import.run-not-found');
  return run;
}

/** Durable account ownership excludes foreign/live tickets and keeps activation available after staging expires. */
export function activationCandidates(
  run: ActivationRun,
  after?: string | null,
  requestedAt?: Date,
) {
  return and(
    eq(tickets.brandId, run.brandId),
    isNotNull(tickets.importedAt),
    eq(tickets.importSource, run.source),
    isNull(tickets.importSlaStartedAt),
    isNull(tickets.deletedAt),
    isNull(tickets.mergedIntoId),
    eq(ticketStatuses.brandId, run.brandId),
    ne(ticketStatuses.systemState, 'closed'),
    eq(ticketStatuses.excludedFromReports, false),
    after ? gt(tickets.id, after) : undefined,
    requestedAt ? lte(tickets.importedAt, requestedAt) : undefined,
    sql`EXISTS (SELECT 1 FROM import_external_ids e WHERE e.brand_id = ${run.brandId}::uuid AND e.source = ${run.source}
      AND e.source_account_key = ${run.sourceAccountKey} AND e.entity = 'ticket' AND e.helpdock_id = ${tickets.id})`,
  );
}

export function activationAvailable(run: ActivationRun) {
  return (
    run.status === 'completed' && run.finishedAt !== null && run.sourceAccountKey !== '0'.repeat(64)
  );
}

export async function importedSlaOverview(
  tx: DbTransaction,
  scope: ImportRunRef,
  now = new Date(),
) {
  const run = await activationRun(tx, scope);
  const available = activationAvailable(run);
  const state = activationState(run);
  const cutoff =
    state && ['queued', 'running', 'failed'].includes(state.status)
      ? new Date(state.requestedAt)
      : now;
  const [row] = available
    ? await tx
        .select({ total: count() })
        .from(tickets)
        .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
        .where(activationCandidates(run, null, cutoff))
    : [];
  return importSlaOverviewSchema.parse({
    available,
    eligible: row?.total ?? 0,
    activation: state
      ? importSlaActivationSchema.parse({
          status: state.status,
          requestedAt: state.requestedAt,
          updatedAt: state.updatedAt,
          checked: state.checked,
          started: state.started,
          skipped: state.skipped,
        })
      : null,
  });
}

export async function storeActivation(tx: DbTransaction, run: ActivationRun, raw: ActivationState) {
  const state = importSlaActivationStateSchema.parse(raw);
  await tx
    .update(importRuns)
    .set({ options: { ...run.options, slaActivation: state } })
    .where(and(eq(importRuns.brandId, run.brandId), eq(importRuns.id, run.id)));
}
