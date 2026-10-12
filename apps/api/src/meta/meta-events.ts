import type { DbTransaction } from '@helpdock/db';
import {
  enqueueOutbox,
  type MetaMediaFetchPayload,
  type MetaProfileFetchPayload,
  type MetaSendPayload,
  metaProfileFetchPayloadSchema,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import { metaFileRefSchema } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * M10's outbox events (DOMAIN-RULES §6, ADR 0025).
 *
 * ```
 * agent reply   → meta_deliveries + outbox(meta.reply)          (one transaction)
 * inbound file  → attachments(pending) + outbox(meta.media)      (the webhook's transaction)
 * new customer  → meta_conversations + outbox(meta.profile)       (M10-05: the name is a job's)
 * account saved → outbox(meta_account.changed) → the health job follows
 * relay         → BullMQ outbox.event                            (after commit)
 * worker        → these handlers → BullMQ meta.send / meta.media_fetch / meta.profile_fetch (jobId from the outbox id)
 * ```
 *
 * The webhook never calls Graph. A reply that rolls back must not reach the
 * customer, and a media file is fetched by a job because Meta wants the
 * webhook answered within seconds (ADR 0025, 6).
 *
 * The payloads are the jobs' own schemas in `@helpdock/jobs`: `meta.send`'s
 * (M10-06), `meta.media_fetch`'s (M10-03) and `meta.profile_fetch`'s (M10-05).
 */

export const META_EVENTS = {
  reply: 'meta.reply',
  media: 'meta.media',
  /** M10-05: a Messenger or Instagram customer's name is wanted. */
  profile: 'meta.profile',
  accountChanged: 'meta_account.changed',
} as const;

export const metaReplyEventSchema = z.object({ deliveryId: z.uuid() });

export const metaMediaEventSchema = z.object({
  attachmentId: z.uuid(),
  accountId: z.uuid(),
  ref: metaFileRefSchema,
});
export type MetaMediaEvent = z.infer<typeof metaMediaEventSchema>;

/** What the `meta.profile` event carries: the job's payload without the brand, which the outbox row has. */
export const metaProfileEventSchema = metaProfileFetchPayloadSchema.omit({ brandId: true });
export type MetaProfileEvent = z.infer<typeof metaProfileEventSchema>;

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

export const enqueueMetaProfile = async (
  tx: DbTransaction,
  brandId: string,
  profile: MetaProfileEvent,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: META_EVENTS.profile,
    payload: metaProfileEventSchema.parse(profile),
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

/** The producer half of `meta.send`; the worker hands it a BullMQ queue. */
export interface MetaSendQueue {
  add(input: { readonly jobId: string; readonly payload: MetaSendPayload }): Promise<void>;
}

/** The producer half of `meta.media_fetch`. */
export interface MetaMediaFetchQueue {
  add(input: { readonly jobId: string; readonly payload: MetaMediaFetchPayload }): Promise<void>;
}

/** The producer half of `meta.profile_fetch`. */
export interface MetaProfileFetchQueue {
  add(input: { readonly jobId: string; readonly payload: MetaProfileFetchPayload }): Promise<void>;
}

/** BullMQ refuses a custom job id with a colon; the outbox id has none. */
export const metaSendJobId = (outboxId: string): string => `meta.send.${outboxId}`;

export const metaMediaFetchJobId = (outboxId: string): string => `meta.media_fetch.${outboxId}`;

export const metaProfileFetchJobId = (outboxId: string): string => `meta.profile_fetch.${outboxId}`;

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

export const createMetaProfileEventHandler =
  (queue: MetaProfileFetchQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, payload }) => {
    const profile = metaProfileEventSchema.parse(payload);
    await queue.add({
      jobId: metaProfileFetchJobId(outboxId),
      payload: { brandId, ...profile },
    });
  };

/**
 * Called by the worker's start-up, before the consumer exists
 * (`worker/start-worker.ts`). The four consumers are required, so a Meta outbox
 * event is never left without a handler: `meta.reply` queues a send on
 * `outbound`, `meta.media` and `meta.profile` queue a fetch on `inbound`, and an
 * account that changed moves its hourly health check. The call is made once,
 * because the dispatcher refuses a second handler for an event.
 */
export const registerMetaEventHandlers = ({
  sendQueue,
  mediaQueue,
  profileQueue,
  accountChanged,
}: {
  readonly sendQueue: MetaSendQueue;
  readonly mediaQueue: MetaMediaFetchQueue;
  readonly profileQueue: MetaProfileFetchQueue;
  readonly accountChanged: OutboxEventHandler;
}): void => {
  registerEventHandler(META_EVENTS.reply, createMetaReplyEventHandler(sendQueue));
  registerEventHandler(META_EVENTS.media, createMetaMediaEventHandler(mediaQueue));
  registerEventHandler(META_EVENTS.profile, createMetaProfileEventHandler(profileQueue));
  registerEventHandler(META_EVENTS.accountChanged, accountChanged);
};
