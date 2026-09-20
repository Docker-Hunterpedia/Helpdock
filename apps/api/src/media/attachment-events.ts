import type { DbTransaction } from '@helpdock/db';
import {
  enqueueOutbox,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import { attachmentChangedSchema, REALTIME_EVENTS, ticketRoom } from '@helpdock/schemas';
import { z } from 'zod';
import type { RealtimeBroadcast } from '../realtime/broadcast.js';

/**
 * How a confirmed upload becomes processed bytes and, when it is done, a frame
 * on the ticket's socket — by the only route DOMAIN-RULES §6 allows.
 *
 * ```
 * confirm  →  attachments.status = processing + outbox         (one transaction)
 * relay    →  BullMQ outbox.event                              (after commit)
 * worker   →  this handler → BullMQ media.process              (jobId = attachmentId)
 * worker   →  process.job.ts → attachments.status + outbox     (one transaction)
 * relay    →  BullMQ outbox.event
 * worker   →  this handler → Redis → api replicas → sockets
 * ```
 *
 * Two outbox rows, and each one is written in the same transaction as the
 * change it describes. The alternative — `queue.add` from the confirm handler —
 * would add a job for a transaction that may still roll back, which is exactly
 * the drift the outbox exists to prevent.
 */

export const ATTACHMENT_EVENTS = {
  /** Confirmed: the object is in the bucket and wants processing. */
  uploaded: 'attachment.uploaded',
  /** Processing finished, either way. The composer swaps its placeholder. */
  ready: 'attachment.ready',
} as const;

export const attachmentUploadedPayloadSchema = z.object({
  attachmentId: z.uuid(),
  ticketId: z.uuid(),
});
export type AttachmentUploadedPayload = z.infer<typeof attachmentUploadedPayloadSchema>;

/**
 * What the finished event carries. Ids and a status — never a URL, because a
 * presigned URL is issued to a caller who was authorised on the parent ticket
 * at that moment, and one broadcast to a room would outlive that check
 * (DOMAIN-RULES §4.5).
 */
export const attachmentReadyPayloadSchema = z.object({
  attachmentId: z.uuid(),
  ticketId: z.uuid(),
  departmentId: z.uuid(),
  status: z.enum(['ready', 'rejected', 'infected']),
});
export type AttachmentReadyPayload = z.infer<typeof attachmentReadyPayloadSchema>;

export const enqueueAttachmentUploaded = (
  tx: DbTransaction,
  brandId: string,
  payload: AttachmentUploadedPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: ATTACHMENT_EVENTS.uploaded,
    payload: attachmentUploadedPayloadSchema.parse(payload),
  });

export const enqueueAttachmentReady = (
  tx: DbTransaction,
  brandId: string,
  payload: AttachmentReadyPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: ATTACHMENT_EVENTS.ready,
    payload: attachmentReadyPayloadSchema.parse(payload),
  });

/** What the `attachment.uploaded` handler needs to put a job on the media queue. */
export interface MediaQueue {
  add(options: {
    jobId: string;
    payload: { brandId: string; attachmentId: string };
  }): Promise<void>;
}

/**
 * Turns the outbox row into the `media.process` job.
 *
 * `jobId` is the attachment id rather than the outbox id: a redelivery of this
 * event — which the outbox promises is possible — must not produce a second
 * processing job, and BullMQ ignores an `add` whose id it already holds. Past
 * that window the job's own `job_receipts` key stops it (DOMAIN-RULES §6).
 */
export const createAttachmentUploadedHandler =
  (queue: MediaQueue): OutboxEventHandler =>
  async ({ brandId, payload }: OutboxEventContext): Promise<void> => {
    const { attachmentId } = attachmentUploadedPayloadSchema.parse(payload);

    await queue.add({ jobId: attachmentId, payload: { brandId, attachmentId } });
  };

/**
 * Turns the finished event into a socket frame on the ticket's room.
 *
 * Only `ticket:<id>`, not the department queue: a list row does not change when
 * a thumbnail appears, and whoever is looking at the thread is in the ticket
 * room already.
 */
export const createAttachmentReadyHandler =
  (broadcast: RealtimeBroadcast): OutboxEventHandler =>
  async ({ brandId, payload }: OutboxEventContext): Promise<void> => {
    const parsed = attachmentReadyPayloadSchema.parse(payload);

    await broadcast.emit({
      rooms: [ticketRoom(parsed.ticketId)],
      event: REALTIME_EVENTS.attachmentChanged,
      data: attachmentChangedSchema.parse({
        brandId,
        ticketId: parsed.ticketId,
        departmentId: parsed.departmentId,
        attachmentId: parsed.attachmentId,
        status: parsed.status,
      }),
      // No cursor: DOMAIN-RULES §7 reserves `seq` for what a client replays,
      // and there is nothing to replay — the thread read carries the status.
      seq: null,
    });
  };

/**
 * Registered by the worker before the `outbox.event` consumer starts, for the
 * reason `packages/jobs/README.md` gives: a job that arrives before its handler
 * fails as an unknown event and burns attempts.
 */
export const registerAttachmentEventHandlers = (options: {
  broadcast: RealtimeBroadcast;
  queue: MediaQueue;
}): void => {
  registerEventHandler(ATTACHMENT_EVENTS.uploaded, createAttachmentUploadedHandler(options.queue));
  registerEventHandler(ATTACHMENT_EVENTS.ready, createAttachmentReadyHandler(options.broadcast));
};
