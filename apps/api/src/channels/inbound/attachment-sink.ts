import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InboundFile } from '@helpdock/channels';
import type { DbTransaction } from '@helpdock/db';
import { type AttachmentKind, safeFileName } from '@helpdock/schemas';
import { enqueueAttachmentUploaded } from '../../media/attachment-events.js';
import { checkUpload, PolicyRefusal, readContentPolicy } from '../../media/content-policy.js';
import { attachmentKey, ORIGINAL_VARIANT } from '../../media/keys.js';
import type { MediaRepository } from '../../media/media.repository.js';
import type { ObjectStorage } from '../../media/storage.js';
import { withTempDir } from '../../media/temp-dir.js';
import type { AttachmentSink } from './conversation-router.js';

/**
 * An email's files into M1-10's media pipeline (M2-02: "attachments to S3").
 *
 * The same path an agent's upload takes after its PUT, and the same rules:
 * the brand's content policy is applied to the *declared* type and size first,
 * the bytes go to the object key a presigned upload would have used, the row
 * starts `pending`, and `attachment.uploaded` is written to the outbox in the
 * message's own transaction so `media.process` sniffs, re-encodes and scans it
 * once the message has committed (DOMAIN-RULES §6). A file the policy refuses
 * is still recorded, `rejected` with its reason and without any bytes, so the
 * agent sees that something was sent and why it is not there.
 *
 * The bytes are uploaded *before* the transaction commits, because the job
 * that reads them may start the instant it does. A transaction that then rolls
 * back leaves objects nothing points at; `uploaded` names them so the caller
 * removes them.
 */

export const kindForMime = (mime: string): AttachmentKind => {
  const type = mime.toLowerCase();
  if (type.startsWith('image/')) {
    return 'image';
  }
  if (type.startsWith('video/')) {
    return 'video';
  }
  if (type.startsWith('audio/')) {
    return 'audio';
  }
  return 'file';
};

/** `image/png; name=x` → `image/png`. */
const bareMime = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase() || 'application/octet-stream';

export class StorageAttachmentSink implements AttachmentSink {
  readonly #storage: ObjectStorage;
  readonly #media: MediaRepository;
  /** Every key uploaded through this sink, so a rolled-back caller can remove them. */
  readonly uploaded: string[] = [];

  constructor(storage: ObjectStorage, media: MediaRepository) {
    this.#storage = storage;
    this.#media = media;
  }

  async store(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly ticketId: string;
      readonly departmentId: string;
      readonly messageId: string;
      readonly contactId: string;
      readonly files: readonly InboundFile[];
      readonly ids: readonly string[];
    },
  ): Promise<void> {
    const policy = readContentPolicy(await this.#media.contentPolicy(tx, input.brandId));
    // The composer's cap applies to mail too; what is over it is left out
    // rather than stored as a message nobody could have sent from the desk.
    const files = input.files.slice(0, policy.maxAttachmentsPerMessage);

    for (const [index, file] of files.entries()) {
      const id = input.ids[index];
      /* c8 ignore next 3 -- the router hands one id per file. */
      if (id === undefined) {
        continue;
      }
      await this.#storeOne(tx, input, file, id, policy);
    }
  }

  async #storeOne(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly ticketId: string;
      readonly departmentId: string;
      readonly messageId: string;
      readonly contactId: string;
    },
    file: InboundFile,
    id: string,
    policy: ReturnType<typeof readContentPolicy>,
  ): Promise<void> {
    const mime = bareMime(file.contentType);
    const kind = kindForMime(mime);
    const key = attachmentKey(
      { brandId: input.brandId, ticketId: input.ticketId, attachmentId: id },
      ORIGINAL_VARIANT,
    );
    const base = {
      id,
      brandId: input.brandId,
      ticketId: input.ticketId,
      // The trigger confirms it against the ticket, as for every child row.
      departmentId: input.departmentId,
      messageId: input.messageId,
      uploaderType: 'contact' as const,
      uploaderId: input.contactId,
      s3Key: key,
      originalName: safeFileName(file.filename),
      mime,
      size: file.content.length,
      kind,
    };

    try {
      checkUpload(policy, { kind, mime, size: file.content.length });
    } catch (error) {
      if (!(error instanceof PolicyRefusal)) {
        throw error;
      }
      await this.#media.insert(tx, {
        ...base,
        status: 'rejected',
        rejectReason: error.reason,
        processedAt: new Date(),
      });
      return;
    }

    await withTempDir(async (dir) => {
      const file_ = path.join(dir, 'original');
      await writeFile(file_, file.content);
      await this.#storage.upload({ key, path: file_, contentType: mime });
    });
    this.uploaded.push(key);

    await this.#media.insert(tx, base);
    await enqueueAttachmentUploaded(tx, input.brandId, {
      attachmentId: id,
      ticketId: input.ticketId,
    });
  }
}
