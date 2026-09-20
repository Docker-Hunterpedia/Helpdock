import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment as AttachmentRow, DbTransaction } from '@helpdock/db';
import type { JobHandler, JobLogger, MediaProcessPayload } from '@helpdock/jobs';
import type {
  AttachmentRejectReason,
  AttachmentScanStatus,
  AttachmentVariant,
  AttachmentVariants,
  ContentPolicy,
  DerivedVariantName,
} from '@helpdock/schemas';
import { policyFor } from '@helpdock/schemas';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { enqueueAttachmentReady } from './attachment-events.js';
import { readContentPolicy } from './content-policy.js';
import { MediaToolError, type MediaTools } from './ffmpeg.js';
import { attachmentKey } from './keys.js';
import { bytesMatchMime, MAGIC_BYTES_PROBE } from './magic-bytes.js';
import { MediaRepository } from './media.repository.js';
import type { FileScanner } from './scanner.js';
import { type ObjectStorage, ObjectTooLargeError } from './storage.js';
import { withTempDir } from './temp-dir.js';
import {
  IMAGE_MAX_EDGE,
  IMAGE_QUALITY,
  IMAGE_VARIANTS,
  keepsOriginal,
  POSTER_AT_SECONDS,
  THUMBNAIL_WIDTHS,
  VARIANT_MIME,
} from './variants.js';

/**
 * `media.process` (ARCHITECTURE §9): the worker that turns a confirmed upload
 * into something this install is willing to serve.
 *
 * ```
 * download → sniff → (image: sharp | audio: ffmpeg | video: poster | file: scan)
 *          → upload the variants → status = ready + outbox(attachment.ready)
 * ```
 *
 * Four rules.
 *
 * **A verdict is not an error.** Bytes that are not what they claimed, an image
 * that will not decode, a file the scanner caught: the row becomes `rejected`
 * or `infected` and the job *returns*. Throwing would retry a decision that
 * cannot come out differently, and would burn three attempts before the person
 * waiting is told anything. Only infrastructure — the bucket, the database —
 * throws and is retried.
 *
 * **Every external call has a deadline.** A crafted file that makes a decoder
 * loop is a worker that never drains its queue, so sharp, ffmpeg, ffprobe and
 * clamd all run against a budget and are killed past it.
 *
 * **Temporary files always go.** `withTempDir` removes the directory in a
 * `finally`, so a rejected 50 MB video does not stay on the worker's disk.
 *
 * **Nothing a stranger typed reaches a filesystem or a command line.** Paths
 * are built from variant names, arguments are an array with no shell between,
 * and the uploaded filename never leaves the column it is stored in.
 *
 * *On the transaction.* `createWorker` opens the brand's transaction and claims
 * the `job_receipts` key before this runs, so the status change and the receipt
 * commit together — a failure rolls both back and the next attempt starts from
 * nothing. The transaction is therefore held for the length of the conversion,
 * which is why every budget below is small and why {@link MEDIA_BUDGET_MS}
 * states their worst case: it is bounded and written down rather than
 * discovered on a busy install.
 */

/** Per-step deadlines. Their sum is what an open transaction is bounded by. */
export const TIMEOUTS_MS = Object.freeze({
  /** One sharp decode and encode. Four of them run per image: probe + three. */
  image: 30_000,
  /** ffmpeg transcoding a voice note capped at a few megabytes. */
  audio: 60_000,
  /** ffmpeg seeking one second in and writing one frame. */
  poster: 30_000,
  ffprobe: 15_000,
  /** clamd streaming a file of up to the `file` cap. */
  scan: 120_000,
} as const);

/** How many sharp calls one image costs: the metadata probe and three encodes. */
const IMAGE_STEPS = 4;

/**
 * The worst case a `media.process` job holds its transaction open for. The
 * kinds are exclusive, so it is the slowest of them rather than their sum —
 * except that a video pays for a poster *and* the sharp encode of it.
 */
export const MEDIA_BUDGET_MS = Math.max(
  TIMEOUTS_MS.image * IMAGE_STEPS,
  TIMEOUTS_MS.audio + TIMEOUTS_MS.ffprobe,
  TIMEOUTS_MS.poster + TIMEOUTS_MS.image + TIMEOUTS_MS.ffprobe,
  TIMEOUTS_MS.scan,
);

/**
 * sharp's decompression-bomb guard. A 100 KB PNG can declare 40 000 × 40 000
 * pixels, and decoding it is six gigabytes of memory. §9 asks the *output* to
 * be 2048 px; the input may be considerably larger than that and no larger than
 * this.
 */
const MAX_INPUT_PIXELS = 64_000_000;

/**
 * A sharp pipeline with both of its guards on: the pixel ceiling above, and a
 * deadline, because "every external call has a deadline" has to include this
 * one. libvips runs in a thread pool outside the event loop, so an image built
 * to be slow would otherwise occupy a worker with nothing to stop it.
 */
const openImage = (source: string): Sharp =>
  sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).timeout({
    seconds: Math.ceil(TIMEOUTS_MS.image / 1_000),
  });

export interface MediaProcessorOptions {
  readonly storage: ObjectStorage;
  readonly tools: MediaTools;
  /** `undefined` when `CLAMAV_HOST` is unset, which is `scan_status = skipped`. */
  readonly scanner: FileScanner | undefined;
  readonly attachments?: MediaRepository;
}

/**
 * What one processed attachment came to. Returned rather than only logged so
 * the suites can assert on it without reading the row a second time.
 */
export interface ProcessOutcome {
  readonly status: 'ready' | 'rejected' | 'infected' | 'skipped';
  readonly reason?: AttachmentRejectReason;
}

/** A judgement about the bytes. Never retried: the answer cannot change. */
class RejectUpload extends Error {
  readonly reason: AttachmentRejectReason;

  constructor(reason: AttachmentRejectReason) {
    super(`The upload was rejected: ${reason}`);
    this.name = 'RejectUpload';
    this.reason = reason;
  }
}

interface SettleValues {
  readonly status: 'ready' | 'rejected' | 'infected';
  readonly rejectReason?: AttachmentRejectReason;
  readonly scanStatus: AttachmentScanStatus;
  readonly mime?: string;
  readonly variants?: AttachmentVariants;
}

/**
 * Where every outcome ends: the row reaches its final status and the event that
 * announces it is written, in the one transaction.
 *
 * The two writes are together on purpose (DOMAIN-RULES §6). The frame that
 * tells a composer to swap its placeholder must not be emitted for a change
 * that did not commit, and a change that committed without the frame is a
 * placeholder that spins until the client's poll notices.
 */
const settleRow = async ({
  attachments,
  tx,
  row,
  values,
}: {
  attachments: MediaRepository;
  tx: DbTransaction;
  row: AttachmentRow;
  values: SettleValues;
}): Promise<ProcessOutcome> => {
  await attachments.setStatus(tx, row.id, {
    status: values.status,
    rejectReason: values.rejectReason ?? null,
    scanStatus: values.scanStatus,
    ...(values.mime === undefined ? {} : { mime: values.mime }),
    ...(values.variants === undefined ? {} : { variants: values.variants }),
    processedAt: new Date(),
  });

  await enqueueAttachmentReady(tx, row.brandId, {
    attachmentId: row.id,
    ticketId: row.ticketId,
    departmentId: row.departmentId,
    status: values.status,
  });

  return values.rejectReason === undefined
    ? { status: values.status }
    : { status: values.status, reason: values.rejectReason };
};

/**
 * The handler `createWorker(mediaProcessJob, …)` is built with. It returns the
 * outcome so a caller that wants it — the integration suite — can read it; the
 * worker itself ignores the value, because a job is done when it does not
 * throw.
 */
export const createMediaProcessor = ({
  storage,
  tools,
  scanner,
  attachments = new MediaRepository(),
}: MediaProcessorOptions): JobHandler<MediaProcessPayload> & {
  run(context: {
    payload: MediaProcessPayload;
    tx: DbTransaction;
    log: JobLogger;
  }): Promise<ProcessOutcome>;
} => {
  const run = async ({
    payload,
    tx,
    log,
  }: {
    payload: MediaProcessPayload;
    tx: DbTransaction;
    log: JobLogger;
  }): Promise<ProcessOutcome> => {
    const row = await attachments.find(tx, payload.attachmentId);
    if (row === undefined) {
      // Deleted between the confirm and the job, which `DELETE …/attachments/:id`
      // allows while a row is `pending`. Nothing to do and nothing to retry.
      log.info({ attachmentId: payload.attachmentId }, 'the attachment is gone; nothing to do');
      return { status: 'skipped' };
    }
    if (row.status !== 'processing') {
      // A redelivery that outlived its receipt. The first run settled it.
      log.info(
        { attachmentId: row.id, status: row.status },
        'the attachment has already been processed',
      );
      return { status: 'skipped' };
    }

    const policy = readContentPolicy(await attachments.contentPolicy(tx, row.brandId));
    const settle = (values: SettleValues): Promise<ProcessOutcome> =>
      settleRow({ attachments, tx, row, values });

    try {
      const result = await withTempDir((dir) =>
        transform({ row, policy, dir, storage, tools, scanner }),
      );

      return await settle(
        result.scanStatus === 'infected'
          ? { status: 'infected', rejectReason: 'infected', scanStatus: 'infected' }
          : {
              status: 'ready',
              scanStatus: result.scanStatus,
              mime: result.mime,
              variants: result.variants,
            },
      );
    } catch (error) {
      const reason = reasonFor(error);
      if (reason === undefined) {
        // Infrastructure. Throwing asks for a retry and leaves the row
        // `processing`, which is what a client keeps polling on.
        throw error;
      }

      // `err` carries the detail; `reject_reason` carries the key. A tool's
      // stderr quotes the worker's paths and never reaches the row or a client.
      log.warn({ attachmentId: row.id, reason, err: error }, 'the upload was rejected');

      return await settle({ status: 'rejected', rejectReason: reason, scanStatus: 'skipped' });
    }
  };

  const handler: JobHandler<MediaProcessPayload> = async (context) => {
    await run(context);
  };

  return Object.assign(handler, { run });
};

interface TransformResult {
  readonly mime: string;
  readonly variants: AttachmentVariants;
  readonly scanStatus: AttachmentScanStatus;
}

type PutVariant = (
  variant: DerivedVariantName,
  file: string,
  describe: Omit<AttachmentVariant, 'mime' | 'size'>,
) => Promise<void>;

/**
 * Downloads the object under the brand's cap and proves it is what it claimed.
 * Returns its size, which is what a kept `original` records.
 *
 * Three refusals, in the order a person would want to hear them: too big, empty,
 * not that type.
 */
const fetchSource = async ({
  row,
  policy,
  storage,
  to,
}: {
  row: AttachmentRow;
  policy: ContentPolicy;
  storage: ObjectStorage;
  to: string;
}): Promise<number> => {
  try {
    // The cap is the brand's, applied to the bytes as they arrive: the row's
    // `size` came from a `HEAD` the bucket answered, and the file being written
    // is on the worker's own disk.
    await storage.download(row.s3Key, to, policyFor(policy, row.kind).maxBytes);
  } catch (error) {
    if (error instanceof ObjectTooLargeError) {
      throw new RejectUpload('too_large');
    }
    throw error;
  }

  const { size } = await stat(to);
  if (size === 0) {
    throw new RejectUpload('unreadable');
  }

  // ARCHITECTURE §9: "sniff MIME (magic bytes), reject mismatch". The declared
  // type was checked against the brand's allow-list at presign; this is the
  // half a client cannot lie about.
  if (!bytesMatchMime(await firstBytes(to), row.mime)) {
    throw new RejectUpload('mime_mismatch');
  }

  return size;
};

/**
 * Stores one derived object and records it. `variants` is filled as a side
 * effect because the caller needs the whole set afterwards and each renderer
 * only knows its own.
 */
const uploadVariant =
  (
    storage: ObjectStorage,
    row: AttachmentRow,
    variants: Record<string, AttachmentVariant>,
  ): PutVariant =>
  async (variant, file, describe) => {
    const { size } = await stat(file);

    await storage.upload({
      key: attachmentKey(
        { brandId: row.brandId, ticketId: row.ticketId, attachmentId: row.id },
        variant,
      ),
      path: file,
      // Always explicit: an object stored with the bucket's default type is an
      // object a browser sniffs, and a sniffing browser is how a download
      // becomes a rendered document.
      contentType: VARIANT_MIME[variant],
    });

    variants[variant] = { mime: VARIANT_MIME[variant], size, ...describe };
  };

/**
 * The bytes half, with no database in it: download, sniff, convert, upload.
 *
 * Separated so the transaction above is held open only around calls that have a
 * budget, and so the whole pipeline can be exercised against a bucket without a
 * Postgres.
 */
const transform = async ({
  row,
  policy,
  dir,
  storage,
  tools,
  scanner,
}: {
  row: AttachmentRow;
  policy: ContentPolicy;
  dir: string;
  storage: ObjectStorage;
  tools: MediaTools;
  scanner: FileScanner | undefined;
}): Promise<TransformResult> => {
  const source = path.join(dir, 'source');
  const size = await fetchSource({ row, policy, storage, to: source });

  const variants: Record<string, AttachmentVariant> = {};
  const put = uploadVariant(storage, row, variants);

  let scanStatus: AttachmentScanStatus = 'skipped';

  switch (row.kind) {
    case 'image':
      await renderImage(source, dir, put);
      break;
    case 'audio':
      await renderAudio(source, dir, tools, put);
      break;
    case 'video':
      await renderPoster(source, dir, tools, put);
      break;
    case 'file':
      scanStatus = scanner === undefined ? 'skipped' : await scanner.scan(source);
      break;
  }

  if (scanStatus === 'infected') {
    // The bytes go now rather than when the row is written: the object is the
    // dangerous thing, and it must not survive a transaction that rolls back.
    await storage.remove(row.s3Key);
    return { mime: row.mime, variants: {}, scanStatus };
  }
  if (scanStatus === 'error') {
    // A scanner that was configured and did not answer is a failure, never a
    // pass. An install that asked for scanning and silently got none is worse
    // than one that never asked.
    throw new RejectUpload('scan_error');
  }

  if (keepsOriginal(row.kind, policy.keepOriginals)) {
    variants.original = { mime: row.mime, size };
  } else {
    // The uploaded bytes are replaced by what this install encoded, which is
    // what strips EXIF and disarms a polyglot (REQUIREMENTS §5.1). Keeping them
    // would keep exactly what re-encoding exists to get rid of.
    await storage.remove(row.s3Key);
  }

  return { mime: row.mime, variants, scanStatus };
};

/**
 * WebP at quality 82, at most 2048 px on the long edge, plus thumbnails at 320
 * and 960 — and no metadata at all, which is how EXIF and ICC are stripped
 * (ARCHITECTURE §9). sharp drops metadata unless `keepMetadata` asks for it,
 * and `rotate()` applies the EXIF orientation to the pixels first, so an image
 * that relied on a tag to be the right way up still is once the tag is gone.
 */
const renderImage = async (source: string, dir: string, put: PutVariant): Promise<void> => {
  // One decode to prove the body matches the signature. A polyglot whose PNG
  // header is genuine gets this far and leaves as a WebP with nothing appended.
  const metadata = await readMetadata(source);
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new RejectUpload('unreadable');
  }

  for (const variant of IMAGE_VARIANTS) {
    const file = path.join(dir, variant);
    const box =
      variant === 'webp'
        ? { width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE }
        : { width: THUMBNAIL_WIDTHS[variant] };

    const info = await openImage(source)
      .rotate()
      .resize({
        ...box,
        fit: 'inside',
        // An image smaller than the target keeps its own size rather than being
        // blown up into a bigger, blurrier file.
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_QUALITY })
      .toFile(file);

    await put(variant, file, { width: info.width, height: info.height });
  }
};

/** Opus/Ogg, 48 kHz mono 32 kbps, with the duration probed off the result. */
const renderAudio = async (
  source: string,
  dir: string,
  tools: MediaTools,
  put: PutVariant,
): Promise<void> => {
  const file = path.join(dir, 'opus');

  await tools.toOpus({ input: source, output: file, timeoutMs: TIMEOUTS_MS.audio });

  const durationMs = await tools.durationMs({ input: file, timeoutMs: TIMEOUTS_MS.ffprobe });

  await put('opus', file, durationMs === undefined ? {} : { durationMs });
};

/**
 * One frame a second in. The video itself is stored as it arrived — v1 does not
 * transcode video — and the frame goes through sharp on its way to WebP, so the
 * poster is encoded by the same thing every other image here is and carries no
 * metadata from the container it came out of.
 */
const renderPoster = async (
  source: string,
  dir: string,
  tools: MediaTools,
  put: PutVariant,
): Promise<void> => {
  const frame = path.join(dir, 'frame.png');
  const file = path.join(dir, 'poster');

  await tools.posterFrame({
    input: source,
    output: frame,
    atSeconds: POSTER_AT_SECONDS,
    timeoutMs: TIMEOUTS_MS.poster,
  });

  const info = await openImage(frame)
    .resize({
      width: IMAGE_MAX_EDGE,
      height: IMAGE_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: IMAGE_QUALITY })
    .toFile(file);

  const durationMs = await tools.durationMs({ input: source, timeoutMs: TIMEOUTS_MS.ffprobe });

  await put('poster', file, {
    width: info.width,
    height: info.height,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
};

/** The first bytes of the file, which is all any signature needs. */
const firstBytes = async (file: string): Promise<Uint8Array> => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(MAGIC_BYTES_PROBE);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_BYTES_PROBE, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const readMetadata = async (source: string): Promise<Metadata> => {
  try {
    return await openImage(source).metadata();
  } catch {
    // A file whose magic bytes said PNG and whose body sharp will not decode.
    throw new RejectUpload('unreadable');
  }
};

/**
 * The reason to store for an error, or `undefined` when the error is
 * infrastructure and the job should be retried.
 *
 * A timeout gets a reason of its own so an operator can tell "we will not
 * accept this" from "we ran out of time on this".
 */
const reasonFor = (error: unknown): AttachmentRejectReason | undefined => {
  if (error instanceof RejectUpload) {
    return error.reason;
  }
  if (error instanceof MediaToolError) {
    return error.timedOut ? 'timeout' : 'processing_failed';
  }
  if (isSharpError(error)) {
    return 'unreadable';
  }

  return undefined;
};

/**
 * sharp throws plain `Error`s, so the only handle on them is the message it
 * builds. Narrow on purpose: anything this does not recognise is treated as
 * infrastructure and retried, which errs towards a job that runs again rather
 * than towards an upload rejected for something that was not its fault.
 */
const isSharpError = (error: unknown): boolean =>
  error instanceof Error &&
  /unsupported image format|input (?:file|buffer) contains|input file is missing|pixel limit|vips/i.test(
    error.message,
  );
