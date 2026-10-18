import { brands, type DbTransaction, importRuns } from '@helpdock/db';
import {
  enqueueOutbox,
  importSlaActivateJob,
  importSlaActivatePayloadSchema,
  type OutboxDispatcher,
  outboxEvents,
} from '@helpdock/jobs';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { activationState } from './sla-activation.js';

export const IMPORT_SLA_ACTIVATION_EVENT = 'import.sla_activation_requested';
const payloadSchema = importSlaActivatePayloadSchema.omit({ brandId: true });
export type SlaActivationJob = z.infer<typeof importSlaActivateJob.schema>;

export async function enqueueSlaActivation(tx: DbTransaction, raw: SlaActivationJob) {
  const { brandId, ...payload } = importSlaActivateJob.schema.parse(raw);
  await enqueueOutbox(tx, { brandId, event: IMPORT_SLA_ACTIVATION_EVENT, payload });
}

export function registerSlaActivationEvents(
  queue: { add(payload: SlaActivationJob, jobId: string): Promise<void> },
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
) {
  dispatcher.register(IMPORT_SLA_ACTIVATION_EVENT, async ({ tx, brandId, payload, outboxId }) => {
    const input = payloadSchema.parse(payload);
    const [run] = await tx
      .select({ run: importRuns })
      .from(importRuns)
      .innerJoin(brands, eq(brands.id, importRuns.brandId))
      .where(
        and(
          eq(importRuns.brandId, brandId),
          eq(importRuns.id, input.runId),
          eq(importRuns.status, 'completed'),
          eq(brands.status, 'active'),
        ),
      );
    if (!run) return;
    const state = activationState(run.run);
    if (
      !state ||
      !['queued', 'running'].includes(state.status) ||
      state.revision !== input.revision ||
      state.after !== input.after
    )
      return;
    await queue.add({ brandId, ...input }, `import.sla_activate.${input.runId}.${outboxId}`);
  });
}
