import type { DbTransaction } from '@helpdock/db';
import {
  enqueueOutbox,
  type HelpCenterMediaProcessPayload,
  type HelpCenterPublishDuePayload,
  helpCenterPublishDueJobId,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
} from '@helpdock/jobs';
import {
  HC_ACCESS_CHANGED_EVENT,
  HC_ARTICLE_CHANGED_EVENT,
  HC_MEDIA_UPLOADED_EVENT,
  HC_STRUCTURE_CHANGED_EVENT,
  type HcAccess,
  type HcArticleChangedPayload,
  hcArticleChangedPayloadSchema,
} from '@helpdock/schemas';
import { z } from 'zod';

/**
 * The help center's outbox events (DOMAIN-RULES §6), written in the
 * transaction of the change that causes them.
 *
 * | Event | Written when | Handled here |
 * |---|---|---|
 * | `help_center.article_changed` | a publish, a status or visibility change, a new slug or section | a `scheduled` change adds the delayed publish job; otherwise logged |
 * | `help_center.structure_changed` | a category or section is created, renamed, reordered or removed | logged |
 * | `help_center.access_changed` | the help center becomes public or internal-only | logged |
 * | `help_center.media_uploaded` | an article image is confirmed | adds `help_center.media_process` |
 *
 * The first three are the contract M5-09 promises: search (M5-05) and the
 * page cache (M5-03) subscribe to them under their own subscriber names and
 * re-read through `HelpCenterContentService`, and from M7 `knowledge.sync`
 * re-labels chunks, all within 60 seconds of the commit (the relay polls every
 * 500 ms). Until then the default handler only logs, which is what keeps the
 * events from failing as unknown.
 */

export const enqueueArticleChanged = (
  tx: DbTransaction,
  brandId: string,
  payload: HcArticleChangedPayload,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: HC_ARTICLE_CHANGED_EVENT, payload: { ...payload } });

export const enqueueStructureChanged = (
  tx: DbTransaction,
  brandId: string,
  payload: { readonly kind: 'category' | 'section'; readonly id: string },
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: HC_STRUCTURE_CHANGED_EVENT, payload: { ...payload } });

export const enqueueAccessChanged = (
  tx: DbTransaction,
  brandId: string,
  access: HcAccess,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: HC_ACCESS_CHANGED_EVENT, payload: { access } });

export const enqueueMediaUploaded = (
  tx: DbTransaction,
  brandId: string,
  mediaId: string,
): Promise<string> =>
  enqueueOutbox(tx, { brandId, event: HC_MEDIA_UPLOADED_EVENT, payload: { mediaId } });

/** What the handlers add jobs through. The worker passes BullMQ; a test passes a double. */
export interface HelpCenterQueues {
  addMediaProcess(payload: HelpCenterMediaProcessPayload): Promise<void>;
  /** A publish run for one brand, `delayMs` from now, with the given job id. */
  addPublishDue(
    payload: HelpCenterPublishDuePayload,
    jobId: string,
    delayMs: number,
  ): Promise<void>;
}

/**
 * Past the scheduled minute rather than on it: a delayed job that fires a
 * moment early finds nothing due yet and completes, and the version would
 * then wait for the hourly sweep.
 */
export const PUBLISH_GRACE_MS = 1_000;

export const createArticleChangedHandler =
  (queues: HelpCenterQueues, now: () => Date = () => new Date()): OutboxEventHandler =>
  async ({ brandId, payload, outboxId, event, log }) => {
    const change = hcArticleChangedPayloadSchema.parse(payload);
    if (change.change === 'scheduled' && change.scheduledAt !== undefined) {
      const job = { brandId, tick: new Date(change.scheduledAt).toISOString() };
      const delayMs = Math.max(0, Date.parse(job.tick) - now().getTime() + PUBLISH_GRACE_MS);
      await queues.addPublishDue(job, helpCenterPublishDueJobId(job), delayMs);
    }
    log.info({ event, outboxId, brandId, ...change }, 'help center article changed');
  };

const logOnly: OutboxEventHandler = ({ brandId, outboxId, event, payload, log }) => {
  log.info({ event, outboxId, brandId, payload }, 'help center changed');
  return Promise.resolve();
};

const mediaUploadedPayloadSchema = z.object({ mediaId: z.uuid() });

export const createMediaUploadedHandler =
  (queues: HelpCenterQueues): OutboxEventHandler =>
  async ({ brandId, payload }) => {
    const { mediaId } = mediaUploadedPayloadSchema.parse(payload);
    await queues.addMediaProcess({ brandId, mediaId });
  };

/** Called by the worker's start-up, before any consumer exists. */
export const registerHelpCenterEventHandlers = (
  queues: HelpCenterQueues,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  dispatcher.register(HC_ARTICLE_CHANGED_EVENT, createArticleChangedHandler(queues));
  dispatcher.register(HC_STRUCTURE_CHANGED_EVENT, logOnly);
  dispatcher.register(HC_ACCESS_CHANGED_EVENT, logOnly);
  dispatcher.register(HC_MEDIA_UPLOADED_EVENT, createMediaUploadedHandler(queues));
};
