import {
  type Db,
  type DbTransaction,
  type HcMedia as HcMediaRow,
  hcMedia,
  systemContext,
  uuidv7,
  withTenant,
} from '@helpdock/db';
import {
  type HcMedia,
  type HcMediaPresignRequest,
  type HcMediaPresignResponse,
  hcMediaPath,
  safeFileName,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ObjectStorage } from '../media/storage.js';
import { enqueueMediaUploaded } from './events.js';

/**
 * Article images (M5-02) over the media pipeline of ARCHITECTURE §9: presign
 * a PUT, confirm, and let `help_center.media_process` sniff and re-encode the
 * upload to WebP. The same three rules `media/media.service.ts` states hold
 * here: a claim is not evidence (the size is checked at confirm and the bytes
 * in the worker), nothing is served before the pipeline has finished with it,
 * and serving is a five-minute presigned URL behind a redirect — never a
 * public bucket.
 *
 * **Who may fetch an image.** An article's `<img src>` is this install's
 * redirect route, which answers without a session because the public help
 * center renders the same html for visitors. The route needs the brand and
 * the media id, a UUIDv7 nobody can list; an image in an internal article is
 * therefore as private as its address. That is the accepted trade for images
 * that render in a public page and in the editor alike, and it is written down
 * in the M5 doc.
 */

/** Key of an article image's objects. Built from uuids alone, so nothing typed reaches the bucket. */
export const hcMediaKey = (
  brandId: string,
  mediaId: string,
  variant: 'original' | 'webp',
): string => `brands/${brandId}/help-center/${mediaId}/${variant}`;

export const toHcMedia = (row: HcMediaRow): HcMedia => ({
  id: row.id,
  status: row.status,
  src: row.status === 'ready' ? hcMediaPath(row.brandId, row.id) : null,
  width: row.width,
  height: row.height,
  rejectReason: row.rejectReason,
});

export class HelpCenterMediaService {
  readonly #storage: ObjectStorage;

  constructor(storage: ObjectStorage) {
    this.#storage = storage;
  }

  async presign(
    tx: DbTransaction,
    { brandId, actorId }: { readonly brandId: string; readonly actorId: string },
    request: HcMediaPresignRequest,
  ): Promise<HcMediaPresignResponse> {
    const id = uuidv7();
    const s3Key = hcMediaKey(brandId, id, 'original');
    await tx.insert(hcMedia).values({
      id,
      brandId,
      s3Key,
      originalName: safeFileName(request.fileName),
      mime: request.mime,
      size: request.size,
      purpose: request.purpose ?? 'article',
      uploadedBy: actorId,
    });
    const upload = await this.#storage.presignUpload({
      key: s3Key,
      contentType: request.mime,
      size: request.size,
    });

    return {
      mediaId: id,
      url: upload.url,
      headers: { ...upload.headers },
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  /**
   * "It is uploaded." The object must be there and no larger than was
   * declared; then `help_center.media_uploaded` goes into the outbox in the
   * same transaction as the status change. Confirming twice enqueues once.
   */
  async confirm(tx: DbTransaction, brandId: string, mediaId: string): Promise<HcMedia> {
    const row = await this.#require(tx, mediaId);
    if (row.status !== 'pending') {
      return toHcMedia(row);
    }

    const head = await this.#storage.head(row.s3Key);
    if (head === undefined || head.size > row.size) {
      const [rejected] = await tx
        .update(hcMedia)
        .set({
          status: 'rejected',
          rejectReason: head === undefined ? 'object_missing' : 'too_large',
          processedAt: new Date(),
        })
        .where(eq(hcMedia.id, mediaId))
        .returning();
      return toHcMedia(rejected ?? row);
    }

    const [started] = await tx
      .update(hcMedia)
      .set({ status: 'processing', size: head.size })
      .where(and(eq(hcMedia.id, mediaId), eq(hcMedia.status, 'pending')))
      .returning();
    if (started === undefined) {
      /* c8 ignore next 2 -- another confirm won the race between the read and the update. */
      return toHcMedia(await this.#require(tx, mediaId));
    }
    await enqueueMediaUploaded(tx, brandId, mediaId);

    return toHcMedia(started);
  }

  async get(tx: DbTransaction, mediaId: string): Promise<HcMedia> {
    return toHcMedia(await this.#require(tx, mediaId));
  }

  /**
   * The five-minute URL behind an article's `<img src>`. Opens its own
   * transaction for the brand in the path, because the route is public: a
   * visitor has no principal to scope one with.
   */
  async redirect(db: Db, brandId: string, mediaId: string): Promise<string> {
    const row = await withTenant(db, systemContext(brandId, 'help_center.media'), (tx) =>
      this.#find(tx, mediaId),
    );
    if (row?.status !== 'ready' || row.webpKey === null) {
      throw new NotFoundException('No such image');
    }
    const download = await this.#storage.presignDownload({
      key: row.webpKey,
      contentType: 'image/webp',
      fileName: `${row.id}.webp`,
      inline: true,
    });
    return download.url;
  }

  async #find(tx: DbTransaction, mediaId: string): Promise<HcMediaRow | undefined> {
    const [row] = await tx.select().from(hcMedia).where(eq(hcMedia.id, mediaId)).limit(1);
    return row;
  }

  async #require(tx: DbTransaction, mediaId: string): Promise<HcMediaRow> {
    const row = await this.#find(tx, mediaId);
    if (row === undefined) {
      throw new NotFoundException('No such image');
    }
    return row;
  }
}
