import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox, type OutboxEventHandler, registerEventHandler } from '@helpdock/jobs';
import { type MetaFileRef, metaFileRefSchema } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * M10's outbox events (DOMAIN-RULES §6, ADR 0025).
 *
 * ```
 * agent reply   → meta_deliveries + outbox(meta.reply)          (one transaction)
 * inbound file  → attachments(pending) + outbox(meta.media)      (the webhook's transaction)
 * account saved → outbox(meta_account.changed) → the health job follows
 * relay         → BullMQ outbox.event                            (after commit)
 * worker        → these handlers → BullMQ meta.send / meta.media_fetch (jobId from the outbox id)
 * ```
 *
 * The webhook never calls Graph. A reply that rolls back must not reach the
 * customer, and a media file is fetched by a job because Meta wants the
 * webhook answered within seconds (ADR 0025, 6).
 *
 * The job payloads are declared here, in the shape the producer half needs,
 * until the jobs themselves exist in `@helpdock/jobs` (`meta.send` with M10-06,
 * `meta.media_fetch` with M10-03); those deliverables replace
 * {@link MetaSendJobPayload} and {@link MetaMediaFetchJobPayload} with the
 * schemas' inferred types.
 */

export const META_EVENTS = {
  reply: 'meta.reply',
  media: 'meta.media',
  accountChanged: 'meta_account.changed',
} as const;

export const metaReplyEventSchema = z.object({ deliveryId: z.uuid() });

export const metaMediaEventSchema = z.object({
  attachmentId: z.uuid(),
  accountId: z.uuid(),
  ref: metaFileRefSchema,
});
export type MetaMediaEvent = z.infer<typeof metaMediaEventSchema>;

export const metaAccountChangedEventSchema = z.object({ accountId: z.uuid() });

export const enqueueMetaReply = async (
  tx: DbTransaction,
  brandId: string,
  deliveryId: string,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: META_EVENTS.reply,
    payload: metaReplyEventSchema.parse({ deliveryId }),
  });

export const enqueueMetaMedia = async (
  tx: DbTransaction,
  brandId: string,
  media: MetaMediaEvent,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: META_EVENTS.media,
    payload: metaMediaEventSchema.parse(media),
  });

export const enqueueMetaAccountChanged = async (
  tx: DbTransaction,
  brandId: string,
  accountId: string,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: META_EVENTS.accountChanged,
    payload: metaAccountChangedEventSchema.parse({ accountId }),
  });

/** What `meta.send` is asked to do. M10-09 adds `kind: 'template'`. */
export interface MetaSendJobPayload {
  readonly kind: 'reply';
  readonly brandId: string;
  /** The `meta_deliveries` row: the whole job is about it, and it is the natural key. */
  readonly deliveryId: string;
}

/** What `meta.media_fetch` is asked to do. */
export interface MetaMediaFetchJobPayload {
  readonly brandId: string;
  readonly attachmentId: string;
  readonly accountId: string;
  readonly ref: MetaFileRef;
}

/** The producer half of `meta.send`; the worker hands it a BullMQ queue. */
export interface MetaSendQueue {
  add(input: { readonly jobId: string; readonly payload: MetaSendJobPayload }): Promise<void>;
}

/** The producer half of `meta.media_fetch`. */
export interface MetaMediaFetchQueue {
  add(input: { readonly jobId: string; readonly payload: MetaMediaFetchJobPayload }): Promise<void>;
}

/** BullMQ refuses a custom job id with a colon; the outbox id has none. */
export const metaSendJobId = (outboxId: string): string => `meta.send.${outboxId}`;

export const metaMediaFetchJobId = (outboxId: string): string => `meta.media_fetch.${outboxId}`;

export const createMetaReplyEventHandler =
  (queue: MetaSendQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, payload }) => {
    const { deliveryId } = metaReplyEventSchema.parse(payload);
    await queue.add({
      jobId: metaSendJobId(outboxId),
      payload: { kind: 'reply', brandId, deliveryId },
    });
  };

export const createMetaMediaEventHandler =
  (queue: MetaMediaFetchQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, payload }) => {
    const media = metaMediaEventSchema.parse(payload);
    await queue.add({
      jobId: metaMediaFetchJobId(outboxId),
      payload: { brandId, ...media },
    });
  };

/**
 * Called by the worker's start-up, before the consumer exists
 * (`worker/start-worker.ts`). Every consumer is optional because they land one
 * deliverable at a time (`meta.send` with M10-06, `meta.media_fetch` with
 * M10-03, the health follower with M10-10): each adds its own to the one call,
 * which is made once, because the dispatcher refuses a second handler for an
 * event.
 */
export const registerMetaEventHandlers = ({
  sendQueue,
  mediaQueue,
  accountChanged,
}: {
  readonly sendQueue?: MetaSendQueue;
  readonly mediaQueue?: MetaMediaFetchQueue;
  readonly accountChanged?: OutboxEventHandler;
}): void => {
  if (sendQueue !== undefined) {
    registerEventHandler(META_EVENTS.reply, createMetaReplyEventHandler(sendQueue));
  }
  if (mediaQueue !== undefined) {
    registerEventHandler(META_EVENTS.media, createMetaMediaEventHandler(mediaQueue));
  }
  if (accountChanged !== undefined) {
    registerEventHandler(META_EVENTS.accountChanged, accountChanged);
  }
};
