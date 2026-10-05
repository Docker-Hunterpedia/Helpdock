import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TelegramOutgoingFile } from '@helpdock/channels';
import { type Attachment, attachments, type DbTransaction } from '@helpdock/db';
import type { AttachmentVariants, DownloadVariant } from '@helpdock/schemas';
import { asc, eq } from 'drizzle-orm';
import { readVariants } from '../media/attachment-view.js';
import { objectKeyBeside } from '../media/keys.js';
import { downloadName } from '../media/media.service.js';
import type { ObjectStorage } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';

/**
 * The files of an agent's reply, as Telegram receives them (M6-02): each one
 * after the text, a photo as a photo and anything else as a document.
 *
 * What is sent is what the media pipeline made of the upload, never bytes it
 * has not checked: an image's WebP (or the kept original), a voice note's Opus,
 * a file's original. A file the pipeline refused is left out.
 */

/** `sendDocument` takes 50 MB; a file past it would fail the whole reply for good. */
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** `sendPhoto` takes 10 MB; a larger image goes as a document instead. */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export type OutgoingPlan =
  /** The pipeline is still working on it: the job tries again later. */
  | { readonly kind: 'wait' }
  /** Refused, or nothing Telegram would take: nothing is sent for it. */
  | { readonly kind: 'skip' }
  | {
      readonly kind: 'send';
      readonly method: 'photo' | 'document';
      readonly variant: DownloadVariant;
      readonly size: number;
    };

/** Which object of an image to send: the kept original, else the WebP. */
const IMAGE_VARIANTS: readonly DownloadVariant[] = ['original', 'webp'];
/** For anything else, what the pipeline normalised first, then the upload. */
const FILE_VARIANTS: readonly DownloadVariant[] = ['opus', 'original'];

const firstOf = (
  variants: AttachmentVariants,
  order: readonly DownloadVariant[],
): { variant: DownloadVariant; size: number } | undefined => {
  for (const variant of order) {
    const stored = variants[variant];
    if (stored !== undefined) {
      return { variant, size: stored.size };
    }
  }
  return undefined;
};

export const planOutgoingFile = (
  row: Pick<Attachment, 'status' | 'kind' | 'variants'>,
): OutgoingPlan => {
  if (row.status === 'pending' || row.status === 'processing') {
    return { kind: 'wait' };
  }
  if (row.status !== 'ready') {
    return { kind: 'skip' };
  }

  const variants = readVariants(row.variants);
  const image = row.kind === 'image';
  const chosen = firstOf(variants, image ? IMAGE_VARIANTS : FILE_VARIANTS);
  if (chosen === undefined || chosen.size > TELEGRAM_UPLOAD_MAX_BYTES) {
    return { kind: 'skip' };
  }

  return {
    kind: 'send',
    method: image && chosen.size <= TELEGRAM_PHOTO_MAX_BYTES ? 'photo' : 'document',
    ...chosen,
  };
};

/** A reply's attachments in the order the agent added them. */
export const replyAttachments = (tx: DbTransaction, messageId: string): Promise<Attachment[]> =>
  tx
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));

/** The bytes of the planned object, read through a temporary file the job owns. */
export const readOutgoingFile = (
  storage: ObjectStorage,
  row: Pick<Attachment, 's3Key' | 'originalName'>,
  variant: DownloadVariant,
): Promise<TelegramOutgoingFile> =>
  withTempDir(async (dir) => {
    const file = path.join(dir, 'outgoing');
    await storage.download(objectKeyBeside(row.s3Key, variant), file, TELEGRAM_UPLOAD_MAX_BYTES);
    return { bytes: await readFile(file), fileName: downloadName(row.originalName, variant) };
  });
