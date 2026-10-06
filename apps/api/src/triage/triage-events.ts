import type { DbTransaction } from '@helpdock/db';
import {
  type AiClassifyPayload,
  aiClassifyJob,
  aiClassifyPayloadSchema,
  enqueueOutbox,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import { AI_TRIAGE_REQUESTED_EVENT } from '@helpdock/schemas';

/**
 * How a rule's AI triage action (M7-07) reaches the model, by the only route
 * DOMAIN-RULES §6 allows for a side effect:
 *
 * ```
 * rule run   →  outbox(ai.triage_requested)       same transaction as the run
 * relay      →  this handler → BullMQ ai.classify  jobId = outbox id
 * worker     →  triage.job.ts: complete(), then suggest or apply in a system transaction
 * ```
 */

export const enqueueTriageRequested = (
  tx: DbTransaction,
  brandId: string,
  payload: Omit<AiClassifyPayload, 'brandId'>,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: AI_TRIAGE_REQUESTED_EVENT,
    payload: aiClassifyPayloadSchema.omit({ brandId: true }).parse(payload),
  });

export interface AiQueue {
  add(options: { jobId: string; name: string; payload: unknown }): Promise<void>;
}

/** `jobId` is the outbox row's, so a redelivered event adds no second job. */
export const createTriageRequestedHandler =
  (queue: AiQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, payload }: OutboxEventContext): Promise<void> => {
    const parsed = aiClassifyPayloadSchema.parse({ ...(payload as object), brandId });
    await queue.add({ jobId: outboxId, name: aiClassifyJob.name, payload: parsed });
  };

export const registerTriageEventHandlers = (queue: AiQueue): void => {
  registerEventHandler(AI_TRIAGE_REQUESTED_EVENT, createTriageRequestedHandler(queue));
};
