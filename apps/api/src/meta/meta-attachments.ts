import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '@helpdock/db';
import {
  type AttachmentKind,
  type AttachmentVariants,
  type DownloadVariant,
  META_ATTACHMENT_LIMITS,
  type MetaPlatform,
} from '@helpdock/schemas';
import { readVariants } from '../media/attachment-view.js';
import { objectKeyBeside } from '../media/keys.js';
import { downloadName } from '../media/media.service.js';
import type { ObjectStorage } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';

/**
 * The files of an agent's reply, as WhatsApp, Messenger and Instagram receive
 * them (M10-06): each one a message of its own after the text.
 *
 * What is sent is what the media pipeline made of the upload, never bytes it
 * has not checked: an image's kept original or its WebP, a voice note's Opus, a
 * file's original. A file the pipeline refused is left out; so is one the
 * platform would refuse, by size (`META_ATTACHMENT_LIMITS`) or by type.
 *
 * **Types are the worse case Meta's pages allow** (the research brief behind
 * ADR 0025). WhatsApp takes JPEG and PNG as an image, MP4 and 3GP as a video,
 * AAC, AMR, MP3, M4A and Ogg Opus as audio; Instagram takes JPEG and PNG, a
 * list of audio and video types, and PDF as the only file; Messenger names no
 * list. A file that is not a native type of its kind goes as a document where
 * the platform takes documents (WhatsApp, Messenger), so the pipeline's WebP of
 * an image, which a brand that keeps no originals only has, still reaches a
 * WhatsApp customer. Where it cannot go at all it is left out and the customer
 * is told (`meta:reply.file*`), because a reply that silently lacks its file is
 * worse than one that says so.
 */

/** How a file travels: as the platform's image, audio or video, or as a document. */
export type MetaFileMethod = 'image' | 'audio' | 'video' | 'document';

/**
 * Why a file is left out. `not-sendable` is the pipeline's refusal (rejected,
 * infected, nothing to send), which the composer already showed the agent;
 * the other two are the platform's, and the customer is told.
 */
export type MetaSkipReason = 'not-sendable' | 'unsupported-type' | 'too-large';

export type MetaOutgoingPlan =
  /** The pipeline is still working on it: the job tries again later. */
  | { readonly kind: 'wait' }
  /** Nothing is sent for it. */
  | { readonly kind: 'skip'; readonly reason: MetaSkipReason }
  | {
      readonly kind: 'send';
      readonly method: MetaFileMethod;
      readonly variant: DownloadVariant;
      readonly size: number;
      /** The stored object's media type, which an upload declares. */
      readonly mime: string;
    };

type NativeMethod = Exclude<MetaFileMethod, 'document'>;

/** `null`: the platform names no list, so any type is sent. */
type AcceptedTypes = readonly string[] | null;

const NATIVE_TYPES: Readonly<Record<MetaPlatform, Readonly<Record<NativeMethod, AcceptedTypes>>>> =
  Object.freeze({
    whatsapp: {
      image: ['image/jpeg', 'image/png'],
      audio: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
      video: ['video/mp4', 'video/3gpp'],
    },
    messenger: { image: null, audio: null, video: null },
    instagram: {
      image: ['image/jpeg', 'image/png'],
      audio: ['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav'],
      video: ['video/mp4', 'video/ogg', 'video/x-msvideo', 'video/quicktime', 'video/webm'],
    },
  });

/** The native method of a kind, tried before a document. A file has none. */
const NATIVE_METHOD: Readonly<Record<AttachmentKind, NativeMethod | null>> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: null,
};

/** Which object of an attachment to send, first choice first. */
const VARIANT_ORDER: Readonly<Record<AttachmentKind, readonly DownloadVariant[]>> = {
  image: ['original', 'webp'],
  audio: ['opus', 'original'],
  video: ['original'],
  file: ['original'],
};

const typeAccepted = (platform: MetaPlatform, method: MetaFileMethod, mime: string): boolean => {
  const accepted =
    method === 'document'
      ? META_ATTACHMENT_LIMITS[platform].fileTypes
      : NATIVE_TYPES[platform][method];
  return accepted === null || accepted.includes(mime);
};

const sizeLimit = (platform: MetaPlatform, method: MetaFileMethod): number => {
  const limits = META_ATTACHMENT_LIMITS[platform];
  return method === 'document' ? limits.file : limits[method];
};

const methodsFor = (kind: AttachmentKind): readonly MetaFileMethod[] => {
  const native = NATIVE_METHOD[kind];
  return native === null ? ['document'] : [native, 'document'];
};

const firstThatFits = (
  platform: MetaPlatform,
  kind: AttachmentKind,
  variants: AttachmentVariants,
): MetaOutgoingPlan => {
  let typeFitted = false;
  let existed = false;

  for (const variant of VARIANT_ORDER[kind]) {
    const stored = variants[variant];
    if (stored === undefined) {
      continue;
    }
    existed = true;
    for (const method of methodsFor(kind)) {
      if (!typeAccepted(platform, method, stored.mime)) {
        continue;
      }
      typeFitted = true;
      if (stored.size <= sizeLimit(platform, method)) {
        return { kind: 'send', method, variant, size: stored.size, mime: stored.mime };
      }
    }
  }

  if (!existed) {
    return { kind: 'skip', reason: 'not-sendable' };
  }
  return { kind: 'skip', reason: typeFitted ? 'too-large' : 'unsupported-type' };
};

export const planOutgoingFile = (
  row: Pick<Attachment, 'status' | 'kind' | 'variants'>,
  platform: MetaPlatform,
): MetaOutgoingPlan => {
  if (row.status === 'pending' || row.status === 'processing') {
    return { kind: 'wait' };
  }
  if (row.status !== 'ready') {
    return { kind: 'skip', reason: 'not-sendable' };
  }

  return firstThatFits(platform, row.kind, readVariants(row.variants));
};

/** Whether the customer is told a file was left out: the platform's reasons, not the pipeline's. */
export const customerIsTold = (
  reason: MetaSkipReason,
): reason is Exclude<MetaSkipReason, 'not-sendable'> => reason !== 'not-sendable';

/**
 * The name a file goes under: the upload's own for the object that was kept, and
 * the pipeline's (`label-webp.webp`) for one it made, so a WebP is never named
 * `.jpg`.
 */
export const outgoingFileName = (
  row: Pick<Attachment, 'originalName'>,
  variant: DownloadVariant,
): string => downloadName(row.originalName, variant);

/** A reply's attachments in the order the agent added them: channel-agnostic, so Telegram's query serves. */
export { replyAttachments } from '../telegram/telegram-attachments.js';

/**
 * The bytes of the planned object, read through a temporary file the job owns.
 * `maxBytes` is the plan's own ceiling, not Telegram's 50 MB: a WhatsApp
 * document may be 100 MiB.
 */
export const readOutgoingBytes = (
  storage: ObjectStorage,
  row: Pick<Attachment, 's3Key'>,
  variant: DownloadVariant,
  maxBytes: number,
): Promise<Buffer> =>
  withTempDir(async (dir) => {
    const file = path.join(dir, 'outgoing');
    await storage.download(objectKeyBeside(row.s3Key, variant), file, maxBytes);
    return readFile(file);
  });
