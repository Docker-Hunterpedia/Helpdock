import { open } from 'node:fs/promises';
import path from 'node:path';
import { type DbTransaction, hcMedia } from '@helpdock/db';
import type { HelpCenterMediaProcessPayload, JobHandler, JobLogger } from '@helpdock/jobs';
import { HC_IMAGE_MAX_BYTES } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';
import sharp, { type OutputInfo } from 'sharp';
import { bytesMatchMime, MAGIC_BYTES_PROBE } from '../media/magic-bytes.js';
import { TIMEOUTS_MS } from '../media/process.job.js';
import { type ObjectStorage, ObjectTooLargeError } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';
import { IMAGE_MAX_EDGE, IMAGE_QUALITY } from '../media/variants.js';
import { hcMediaKey } from './media.service.js';

/**
 * `help_center.media_process` (M5-02): an article image through the image
 * half of ARCHITECTURE §9, with the same budgets, guards and verdict rules as
 * `media/process.job.ts` — download under the cap, sniff the magic bytes,
 * re-encode to WebP at quality 82 and at most 2048 px, drop every byte of
 * metadata, and discard the original, which is what disarms a polyglot.
 *
 * A verdict (not an image, will not decode, too large) makes the row
 * `rejected` and the job *returns*; only the bucket or the database throws,
 * and that is retried.
 */

type Verdict = 'object_missing' | 'too_large' | 'unreadable' | 'mime_mismatch';

class Reject extends Error {
  readonly reason: Verdict;

  constructor(reason: Verdict) {
    super(`The image was rejected: ${reason}`);
    this.reason = reason;
  }
}

/** sharp's decompression-bomb ceiling, as for attachments. */
const MAX_INPUT_PIXELS = 64_000_000;

const firstBytes = async (file: string): Promise<Uint8Array> => {
  const handle = await open(file, 'r');
  try {
    const buffer = new Uint8Array(MAGIC_BYTES_PROBE);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_BYTES_PROBE, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export interface HcMediaOutcome {
  readonly status: 'ready' | 'rejected' | 'skipped';
  readonly reason?: Verdict;
}

const convert = async (
  storage: ObjectStorage,
  row: typeof hcMedia.$inferSelect,
  dir: string,
): Promise<{ width: number; height: number; key: string }> => {
  const source = path.join(dir, 'source');
  try {
    await storage.download(row.s3Key, source, HC_IMAGE_MAX_BYTES);
  } catch (error) {
    if (error instanceof ObjectTooLargeError) {
      throw new Reject('too_large');
    }
    throw error;
  }
  if (!bytesMatchMime(await firstBytes(source), row.mime)) {
    throw new Reject('mime_mismatch');
  }

  const target = path.join(dir, 'image.webp');
  let info: OutputInfo;
  try {
    info = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .timeout({ seconds: Math.ceil(TIMEOUTS_MS.image / 1_000) })
      .rotate()
      .resize({
        width: IMAGE_MAX_EDGE,
        height: IMAGE_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_QUALITY })
      .toFile(target);
  } catch {
    throw new Reject('unreadable');
  }

  const key = hcMediaKey(row.brandId, row.id, 'webp');
  await storage.upload({ key, path: target, contentType: 'image/webp' });
  await storage.remove(row.s3Key);
  return { width: info.width, height: info.height, key };
};

export const createHcMediaProcessor = (
  storage: ObjectStorage,
): JobHandler<HelpCenterMediaProcessPayload> & {
  run(context: {
    payload: HelpCenterMediaProcessPayload;
    tx: DbTransaction;
    log: JobLogger;
  }): Promise<HcMediaOutcome>;
} => {
  const run = async ({
    payload,
    tx,
    log,
  }: {
    payload: HelpCenterMediaProcessPayload;
    tx: DbTransaction;
    log: JobLogger;
  }): Promise<HcMediaOutcome> => {
    const [row] = await tx.select().from(hcMedia).where(eq(hcMedia.id, payload.mediaId)).limit(1);
    if (row?.status !== 'processing') {
      log.info({ mediaId: payload.mediaId }, 'the article image is gone or already processed');
      return { status: 'skipped' };
    }

    try {
      const result = await withTempDir((dir) => convert(storage, row, dir));
      await tx
        .update(hcMedia)
        .set({
          status: 'ready',
          mime: 'image/webp',
          webpKey: result.key,
          width: result.width,
          height: result.height,
          processedAt: new Date(),
        })
        .where(eq(hcMedia.id, row.id));
      return { status: 'ready' };
    } catch (error) {
      if (!(error instanceof Reject)) {
        throw error;
      }
      log.warn({ mediaId: row.id, reason: error.reason }, 'the article image was rejected');
      await tx
        .update(hcMedia)
        .set({ status: 'rejected', rejectReason: error.reason, processedAt: new Date() })
        .where(eq(hcMedia.id, row.id));
      return { status: 'rejected', reason: error.reason };
    }
  };

  const handler: JobHandler<HelpCenterMediaProcessPayload> = async (context) => {
    await run(context);
  };

  return Object.assign(handler, { run });
};
