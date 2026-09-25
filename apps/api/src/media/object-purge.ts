import type { DbTransaction } from '@helpdock/db';
import { attachments as attachmentRows } from '@helpdock/db';
import {
  enqueueOutbox,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import { attachmentVariantNameSchema } from '@helpdock/schemas';
import { and, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { objectKeyBeside } from './keys.js';
import type { ObjectStorage } from './storage.js';

/**
 * How attachment bytes leave the bucket when their rows leave the database
 * (M1-14): the closed-ticket and spam purges of DOMAIN-RULES §11, and a
 * contact's erasure.
 *
 * ```
 * purge   →  DELETE attachments … + outbox media.objects.purge    (one transaction)
 * relay   →  BullMQ outbox.event                                  (after commit)
 * worker  →  this handler → S3 DeleteObject per key                (idempotent)
 * ```
 *
 * The keys travel in the outbox row because the rows that named them are gone
 * by the time the worker runs. The other order — delete the objects, then the
 * rows — would put a network call inside the purge transaction and leave rows
 * pointing at nothing if the commit failed; this order can only leave an object
 * for one more retry, never a row for ever.
 */

export const OBJECT_PURGE_EVENT = 'media.objects.purge';

/** Keys per outbox row. Small enough that one row is one short job, and a retry repeats little. */
export const OBJECT_PURGE_CHUNK = 200;

export const objectPurgePayloadSchema = z.object({
  keys: z.array(z.string().min(1).max(512)).min(1).max(OBJECT_PURGE_CHUNK),
});
export type ObjectPurgePayload = z.infer<typeof objectPurgePayloadSchema>;

/** What a purge needs of an attachment row to name every object it may own. */
export interface PurgeableAttachment {
  readonly id: string;
  readonly brandId: string;
  readonly ticketId: string;
  readonly s3Key: string;
}

/**
 * Every object one attachment may own: the key it was uploaded to, and every
 * variant name the pipeline can write. All of them rather than the ones
 * `variants` lists, because a row caught mid-processing may already have
 * written an object its column does not name yet — and deleting a key that is
 * not there is a success.
 *
 * Built beside `s3_key` rather than from the row's ids, because a split's copy
 * (M1-09) owns no folder of its own: it points at the original's objects.
 */
export const attachmentObjectKeys = (attachment: PurgeableAttachment): string[] => {
  const variants = attachmentVariantNameSchema.options.map((variant) =>
    objectKeyBeside(attachment.s3Key, variant),
  );

  return [...new Set([attachment.s3Key, ...variants])];
};

/**
 * The uploads among these rows that some row *not* being removed still names.
 *
 * A split (M1-09) copies an attachment as a second row on the same object, so
 * the bytes belong to every row that names them. Purging one ticket, or
 * erasing one contact's files, must leave an object alone while any other row
 * — the copy on the new ticket, or the original the copy came from — can still
 * be downloaded. The last row to go takes the objects with it.
 */
const stillNamedElsewhere = async (
  tx: DbTransaction,
  removing: readonly PurgeableAttachment[],
): Promise<ReadonlySet<string>> => {
  const rows = await tx
    .select({ s3Key: attachmentRows.s3Key })
    .from(attachmentRows)
    .where(
      and(
        inArray(
          attachmentRows.s3Key,
          removing.map((row) => row.s3Key),
        ),
        notInArray(
          attachmentRows.id,
          removing.map((row) => row.id),
        ),
      ),
    );

  return new Set(rows.map((row) => row.s3Key));
};

/**
 * Writes the outbox rows that will delete these attachments' objects, through
 * the caller's transaction, and returns how many keys were queued. Nothing is
 * written for an empty list, and nothing for an object another row still
 * names (see {@link stillNamedElsewhere}).
 *
 * Called **before** the rows are deleted, in the same transaction, so the
 * rows being removed are told apart from the rest by id.
 */
export const enqueueObjectPurge = async (
  tx: DbTransaction,
  brandId: string,
  attachments: readonly PurgeableAttachment[],
): Promise<number> => {
  if (attachments.length === 0) {
    return 0;
  }
  const shared = await stillNamedElsewhere(tx, attachments);
  const keys = attachments
    .filter((attachment) => !shared.has(attachment.s3Key))
    .flatMap(attachmentObjectKeys);

  for (let start = 0; start < keys.length; start += OBJECT_PURGE_CHUNK) {
    await enqueueOutbox(tx, {
      brandId,
      event: OBJECT_PURGE_EVENT,
      payload: objectPurgePayloadSchema.parse({
        keys: keys.slice(start, start + OBJECT_PURGE_CHUNK),
      }),
    });
  }

  return keys.length;
};

/** Thrown for a key outside the brand's prefix. Unrecoverable: a retry would not make it the brand's. */
export class ForeignObjectKeyError extends Error {
  constructor(brandId: string) {
    super(`An object purge for brand ${brandId} named a key outside that brand's prefix`);
    this.name = 'ForeignObjectKeyError';
  }
}

/**
 * Deletes the objects one outbox row names. Every key must sit under the
 * brand's own prefix (`media/keys.ts`): the row was written inside that
 * brand's transaction, and a handler that trusted it blindly would be one bad
 * row away from deleting another brand's bytes. The check runs before any
 * delete, so a row with one foreign key deletes nothing.
 */
export const createObjectPurgeHandler =
  (storage: ObjectStorage): OutboxEventHandler =>
  async ({ brandId, payload }: OutboxEventContext): Promise<void> => {
    const { keys } = objectPurgePayloadSchema.parse(payload);
    const prefix = `brands/${brandId.toLowerCase()}/`;
    if (keys.some((key) => !key.startsWith(prefix))) {
      throw new ForeignObjectKeyError(brandId);
    }

    for (const key of keys) {
      await storage.remove(key);
    }
  };

/** Registered by the worker before the `outbox.event` consumer starts (`worker/start-worker.ts`). */
export const registerObjectPurgeHandler = (storage: ObjectStorage): void => {
  registerEventHandler(OBJECT_PURGE_EVENT, createObjectPurgeHandler(storage));
};
