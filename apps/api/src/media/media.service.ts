import type { DbTransaction } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import type {
  Attachment,
  AttachmentDownload,
  AttachmentDownloadQuery,
  AttachmentPresignRequest,
  AttachmentPresignResponse,
  ContentPolicy,
  DownloadVariant,
} from '@helpdock/schemas';
import { safeFileName } from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { getTx } from '../context/request-context.js';
import { enqueueAttachmentUploaded } from './attachment-events.js';
import { readVariants, toAttachment } from './attachment-view.js';
import { checkUpload, PolicyRefusal, readContentPolicy } from './content-policy.js';
import { attachmentKey, ORIGINAL_VARIANT, objectKeyBeside } from './keys.js';
import { MediaRepository } from './media.repository.js';
import type { ObjectStorage } from './storage.js';
import { OBJECT_STORAGE } from './tokens.js';
import { uploaderFor } from './uploader.js';
import { servesInline, VARIANT_EXTENSION } from './variants.js';

/**
 * M1-10 over HTTP: presign, confirm, download, delete.
 *
 * Three rules run through every method.
 *
 * **Authorisation is the parent ticket's.** No method here asks who the caller
 * is in order to decide whether an attachment may be reached. The transaction
 * carries the brand and department scope, the `attachments` policy applies it,
 * and a row on another department's ticket is `undefined` — so DOMAIN-RULES
 * §4.5's "presigned GET URLs are issued only by an endpoint that first
 * authorises the caller on the parent ticket" is a property of the read rather
 * than of a check.
 *
 * **A claim is not evidence.** The size and MIME at presign are what the client
 * says it is about to send. They are signed into the upload URL, checked again
 * against the object at confirm, and checked a third time against the magic
 * bytes in the worker (ARCHITECTURE §9).
 *
 * **Bytes are never served until they have been processed.** A download is
 * issued only for `status = 'ready'`, which is the only state in which the
 * object has been sniffed, re-encoded where the kind calls for it, and scanned.
 */
@Injectable()
export class MediaService {
  readonly #attachments: MediaRepository;
  readonly #storage: ObjectStorage;

  constructor(
    @Inject(MediaRepository) attachments: MediaRepository,
    @Inject(OBJECT_STORAGE) storage: ObjectStorage,
  ) {
    this.#attachments = attachments;
    this.#storage = storage;
  }

  /**
   * A row, a key and a URL that accepts exactly one object.
   *
   * The row is written first and on purpose: an upload nobody confirms leaves a
   * `pending` row and, at most, one orphaned object, which retention sweeps. A
   * URL issued without a row would leave an object with nothing pointing at it
   * and no record that it exists.
   */
  async presign(
    brandId: string,
    ticketId: string,
    principal: Principal,
    input: AttachmentPresignRequest,
  ): Promise<AttachmentPresignResponse> {
    const tx = getTx();
    const policy = await this.#policy(tx, brandId);

    this.#refuseOutsidePolicy(policy, input);

    const departmentId = await this.#attachments.ticketDepartment(tx, ticketId);
    if (departmentId === undefined) {
      // Also what a ticket in another department answers: the policy hides it,
      // and saying "forbidden" would confirm that it exists (DOMAIN-RULES §1.2).
      throw new NotFoundException('No such ticket');
    }

    const uploader = uploaderFor(principal);
    // Generated here rather than by the default, because the key has to be
    // built from it before the row exists.
    const attachmentId = uuidv7();
    const key = attachmentKey({ brandId, ticketId, attachmentId }, ORIGINAL_VARIANT);

    const row = await this.#attachments.insert(tx, {
      id: attachmentId,
      brandId,
      ticketId,
      // Overwritten by the `attachments_department` trigger with the ticket's
      // own; this is what the read above saw.
      departmentId,
      uploaderType: uploader.type,
      uploaderId: uploader.id,
      s3Key: key,
      originalName: safeFileName(input.fileName),
      mime: input.mime,
      size: input.size,
      kind: input.kind,
      status: 'pending',
    });

    const upload = await this.#storage.presignUpload({
      key: row.s3Key,
      contentType: input.mime,
      size: input.size,
    });

    return {
      attachmentId: row.id,
      url: upload.url,
      headers: { ...upload.headers },
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  /**
   * "The object is there, process it."
   *
   * `HEAD` before anything else, because the row's `size` so far is a number
   * the client typed. The object's real length is what the caps are measured
   * against and what the policy is re-checked with, so a client that asked to
   * upload one byte and somehow stored fifty megabytes is caught here.
   *
   * **A rejection is answered, not thrown.** The request runs inside the tenant
   * transaction, so an exception would roll the `rejected` row back with
   * everything else and the attachment would sit at `pending` with nothing
   * saying why. It is also the more useful shape: the composer renders the
   * refusal from `status` and `rejectReason`, which are the same two fields it
   * renders a rejection from the worker with, rather than from a status code it
   * would have to map separately.
   */
  async confirm(brandId: string, ticketId: string, attachmentId: string): Promise<Attachment> {
    const tx = getTx();
    const row = await this.#require(tx, ticketId, attachmentId);

    if (row.status !== 'pending') {
      // Confirming twice is not an error — the composer retries — but the
      // second one must not enqueue a second job.
      return toAttachment(row);
    }

    const head = await this.#storage.head(row.s3Key);
    if (head === undefined) {
      return toAttachment(await this.#reject(tx, attachmentId, 'object_missing'));
    }

    const policy = await this.#policy(tx, brandId);
    try {
      checkUpload(policy, { kind: row.kind, mime: row.mime, size: head.size });
    } catch (error) {
      if (error instanceof PolicyRefusal) {
        return toAttachment(await this.#reject(tx, attachmentId, error.reason));
      }
      /* c8 ignore next 2 -- checkUpload throws nothing else. */
      throw error;
    }

    const started = await this.#attachments.startProcessing(tx, attachmentId, head.size);
    if (started === undefined) {
      // Another confirm won the race and is already enqueuing. Answer with the
      // row as it now is rather than enqueueing a second job.
      return toAttachment(await this.#require(tx, ticketId, attachmentId));
    }

    // In the same transaction as the status change, which is the whole of
    // DOMAIN-RULES §6: a confirm that rolls back queues nothing.
    await enqueueAttachmentUploaded(tx, brandId, { attachmentId, ticketId });

    return toAttachment(started);
  }

  /**
   * The row, and a five-minute URL for the variant that was asked for.
   *
   * A variant the row does not have is a 404 rather than a redirect to an
   * object that is not there, and anything that is not `ready` has no URL at
   * all: a client polling a `processing` row reads the status and waits.
   */
  async download(
    _brandId: string,
    ticketId: string,
    attachmentId: string,
    query: AttachmentDownloadQuery,
  ): Promise<AttachmentDownload> {
    const tx = getTx();
    const row = await this.#require(tx, ticketId, attachmentId);

    if (row.status !== 'ready') {
      throw new ConflictException(`That attachment is ${row.status}`);
    }

    const variant = query.variant;
    const stored = readVariants(row.variants)[variant];

    if (stored === undefined) {
      // Including `original` on an image whose brand does not keep originals:
      // those bytes were discarded once the WebP existed, which is the point.
      throw new NotFoundException('No such variant of that attachment');
    }

    const download = await this.#storage.presignDownload({
      // From the stored key, not the ids: a split's copy shares the original's
      // objects (M1-09), and its own ids name an empty folder.
      key: objectKeyBeside(row.s3Key, variant),
      contentType: stored.mime,
      fileName: downloadName(row.originalName, variant),
      // Only what this install encoded is ever inline (REQUIREMENTS §5.1).
      inline: servesInline(variant),
    });

    return {
      attachment: toAttachment(row),
      variant,
      url: download.url,
      expiresAt: download.expiresAt.toISOString(),
    };
  }

  /**
   * Discards an upload the composer changed its mind about.
   *
   * Only `pending` and `rejected` rows: a `ready` attachment is part of a
   * message and is deleted with its ticket by retention (DOMAIN-RULES §11), and
   * an `infected` row is kept deliberately as the record that something was
   * caught. The object goes first, because a row deleted before its object is
   * an object nothing knows the key of.
   */
  async remove(ticketId: string, attachmentId: string): Promise<void> {
    const tx = getTx();
    const row = await this.#require(tx, ticketId, attachmentId);

    if (row.status !== 'pending' && row.status !== 'rejected') {
      throw new ConflictException('That attachment has been sent and cannot be deleted');
    }

    if (!(await this.#attachments.remove(tx, attachmentId, ['pending', 'rejected']))) {
      /* c8 ignore next 2 -- the read above proved the row and its status. */
      throw new NotFoundException('No such attachment');
    }

    // After the row, not before: a delete that fails here leaves an orphaned
    // object for retention to sweep, while the reverse would leave a row
    // pointing at nothing.
    await this.#storage.remove(row.s3Key);
  }

  // ---------------------------------------------------------------- internals

  /** The brand’s content policy, read once per request that needs it. */
  async #policy(tx: DbTransaction, brandId: string): Promise<ContentPolicy> {
    return readContentPolicy(await this.#attachments.contentPolicy(tx, brandId));
  }

  #refuseOutsidePolicy(policy: ContentPolicy, input: AttachmentPresignRequest): void {
    try {
      checkUpload(policy, input);
    } catch (error) {
      if (error instanceof PolicyRefusal) {
        throw refusalToHttp(error);
      }
      /* c8 ignore next 2 -- checkUpload throws nothing else. */
      throw error;
    }
  }

  async #require(tx: DbTransaction, ticketId: string, attachmentId: string) {
    const row = await this.#attachments.find(tx, attachmentId);
    if (row === undefined || row.ticketId !== ticketId) {
      // The `ticketId` comparison matters: the policy has already proved the
      // caller may read the row, but the path named a ticket and an id from
      // another of the caller's tickets must not answer through it.
      throw new NotFoundException('No such attachment');
    }

    return row;
  }

  async #reject(tx: DbTransaction, attachmentId: string, reason: PolicyRefusal['reason']) {
    const rejected = await this.#attachments.setStatus(tx, attachmentId, {
      status: 'rejected',
      rejectReason: reason,
      processedAt: new Date(),
    });

    /* c8 ignore next 3 -- the read above proved the row is visible. */
    if (rejected === undefined) {
      throw new NotFoundException('No such attachment');
    }

    return rejected;
  }
}

/**
 * The status code a refusal deserves. They are deliberately different: a
 * composer shows "too big" and "not allowed here" differently, and a status
 * code is the part of an answer every client already understands.
 */
const refusalToHttp = (refusal: PolicyRefusal): Error => {
  switch (refusal.reason) {
    case 'too_large':
      return new PayloadTooLargeException('That file is larger than this brand allows');
    case 'mime_not_allowed':
      return new UnsupportedMediaTypeException('This brand does not accept that file type');
    case 'kind_disabled':
      return new BadRequestException('This brand does not accept that kind of attachment');
    default:
      return new BadRequestException('That upload was refused');
  }
};

/**
 * What the browser saves the file as. A derived variant is named after the
 * upload with the variant and its own extension appended, so a folder of
 * downloads still says which message they came from.
 */
export const downloadName = (originalName: string, variant: DownloadVariant): string => {
  if (variant === ORIGINAL_VARIANT) {
    return originalName;
  }

  const base = originalName.replace(/\.[^.]+$/, '') || 'attachment';

  return `${base}-${variant}.${VARIANT_EXTENSION[variant]}`;
};
