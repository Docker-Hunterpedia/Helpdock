import type { Attachment as AttachmentRow } from '@helpdock/db';
import type { Attachment, AttachmentVariants } from '@helpdock/schemas';
import { attachmentVariantsSchema } from '@helpdock/schemas';

/**
 * A row to the wire shape. The output DTO parses this again on the way out
 * (ARCHITECTURE §6, step 5); this is where the two vocabularies meet, in one
 * file, so a column added to `attachments` does not quietly become a field in a
 * response.
 *
 * Three columns are deliberately never mapped:
 *
 * | Column | Why |
 * |---|---|
 * | `s3_key` | The bucket layout is the server's. A key in a response is a key in a log (DOMAIN-RULES §4.5) |
 * | `brand_id` | The caller named the brand in the path |
 * | `department_id` | Denormalised for the policy; the ticket already carries it |
 *
 * `uploader_id` is also absent. It is a user id, a contact id or a job name
 * depending on `uploader_type`, and the thread already says who wrote the
 * message an attachment hangs off; returning a second, differently-shaped
 * identity would be a field every client had to learn to ignore.
 */
export const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  ticketId: row.ticketId,
  messageId: row.messageId,
  uploaderType: row.uploaderType,
  originalName: row.originalName,
  mime: row.mime,
  kind: row.kind,
  size: row.size,
  status: row.status,
  rejectReason: row.rejectReason,
  scanStatus: row.scanStatus,
  variants: readVariants(row.variants),
  createdAt: row.createdAt.toISOString(),
  processedAt: row.processedAt?.toISOString() ?? null,
});

/**
 * `variants` is jsonb, so what comes back is whatever was written — by this
 * build or by an older one. A value that does not parse becomes an empty
 * record rather than an error: a thumbnail that cannot be described is a
 * thumbnail that is not offered, not a thread that will not load.
 */
export const readVariants = (stored: unknown): AttachmentVariants => {
  const parsed = attachmentVariantsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : {};
};
