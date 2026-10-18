import {
  auditLog,
  brands,
  type Db,
  importLog,
  importRuns,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import { importSlaActivateJob } from '@helpdock/jobs';
import { and, asc, eq } from 'drizzle-orm';
import { SlaRepository } from '../../sla/sla.repository.js';
import { SlaService } from '../../sla/sla.service.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { activationCandidates, activationState, storeActivation } from '../sla-activation.js';
import { enqueueSlaActivation, type SlaActivationJob } from '../sla-activation-events.js';
import { lockImportBrand } from './claims.js';

/** Activation is a separate, explicit admin job; the historical writer never calls the SLA engine. */
export async function activateImportedSlaBatch(db: Db, raw: SlaActivationJob, jobId: string) {
  const input = importSlaActivateJob.schema.parse(raw);
  await withSystemJob(db, input.brandId, jobId, async (tx) => {
    await lockImportBrand(tx, input.brandId);
    const [row] = await tx
      .select({ run: importRuns })
      .from(importRuns)
      .innerJoin(brands, eq(brands.id, importRuns.brandId))
      .where(
        and(
          eq(importRuns.brandId, input.brandId),
          eq(importRuns.id, input.runId),
          eq(importRuns.status, 'completed'),
          eq(brands.status, 'active'),
        ),
      );
    if (!row) return;
    const state = activationState(row.run);
    if (
      !state ||
      !['queued', 'running'].includes(state.status) ||
      state.revision !== input.revision ||
      state.after !== input.after
    )
      return;
    const candidates = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(activationCandidates(row.run, state.after, new Date(state.requestedAt)))
      .orderBy(asc(tickets.id))
      .limit(51)
      .for('update', { of: tickets });
    const page = candidates.slice(0, 50);
    const sla = new SlaService(new SlaRepository());
    let started = 0;
    for (const ticket of page) {
      if (
        await sla.activateImported(tx, {
          brandId: input.brandId,
          ticketId: ticket.id,
          at: new Date(),
        })
      )
        started++;
    }
    const next = {
      ...state,
      status: candidates.length > 50 ? ('running' as const) : ('completed' as const),
      after: page.at(-1)?.id ?? state.after,
      checked: state.checked + page.length,
      started: state.started + started,
      skipped: state.skipped + page.length - started,
      updatedAt: new Date().toISOString(),
    };
    await storeActivation(tx, row.run, next);
    if (next.status === 'running') await enqueueSlaActivation(tx, { ...input, after: next.after });
    else
      await tx.insert(auditLog).values({
        brandId: input.brandId,
        actorType: 'system',
        actorId: jobId,
        action: 'import.sla-activation-completed',
        targetType: 'import_run',
        targetId: input.runId,
        meta: {
          requestedBy: state.requestedBy,
          checked: next.checked,
          started: next.started,
          skipped: next.skipped,
        },
      });
  });
}

export async function failImportedSlaActivation(db: Db, input: SlaActivationJob, jobId: string) {
  await withSystemJob(db, input.brandId, jobId, async (tx) => {
    await lockImportBrand(tx, input.brandId);
    const [run] = await tx
      .select()
      .from(importRuns)
      .where(and(eq(importRuns.brandId, input.brandId), eq(importRuns.id, input.runId)));
    if (!run) return;
    const state = activationState(run);
    if (
      !state ||
      !['queued', 'running'].includes(state.status) ||
      state.revision !== input.revision ||
      state.after !== input.after
    )
      return;
    await storeActivation(tx, run, {
      ...state,
      status: 'failed',
      updatedAt: new Date().toISOString(),
    });
    await tx.insert(importLog).values({
      brandId: input.brandId,
      runId: input.runId,
      level: 'error',
      message: 'import.sla-activation-failed',
    });
  });
}
