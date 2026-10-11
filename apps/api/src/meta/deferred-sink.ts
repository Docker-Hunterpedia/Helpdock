import type { DbTransaction } from '@helpdock/db';
import {
  type AttachmentKind,
  type AttachmentRejectReason,
  type ContentPolicy,
  type MetaFileRef,
  policyFor,
  safeFileName,
} from '@helpdock/schemas';
import { bareMime, kindForMime } from '../channels/inbound/attachment-sink.js';
import { checkUpload, PolicyRefusal, readContentPolicy } from '../media/content-policy.js';
import { attachmentKey, ORIGINAL_VARIANT } from '../media/keys.js';
import type { MediaRepository } from '../media/media.repository.js';
import { enqueueMetaMedia } from './meta-events.js';

/**
 * The attachment sink of the Meta channels (M10-03, ADR 0025, 6): the files of
 * a message **without their bytes**.
 *
 * `StorageAttachmentSink` (email, Telegram) uploads the object before the
 * message's transaction commits. A Meta webhook has to be answered within
 * seconds and a media file is up to 100 MB, so the request files the message
 * with each attachment `pending` and no object, and writes a `meta.media`
 * outbox row beside it; the `meta.media_fetch` job fetches the bytes, checks
 * them and asks for `attachment.uploaded` (`meta-media.job.ts`).
 *
 * What can be decided without the bytes is decided here, with the same content
 * policy and the same function (`checkUpload`) every upload meets:
 *
 * | The reference | Checked now | Checked by the job, on the bytes |
 * |---|---|---|
 * | WhatsApp media id | the declared type and that its kind is on | the size, the digest, the sniffed type |
 * | CDN link (Messenger, Instagram) | that its kind is on (a link declares no type) | the type the server answered with, the size |
 *
 * A file the policy refuses is still recorded, `rejected` with its reason and
 * no object, so the agent sees that something was sent and why it is not
 * there; nothing is fetched for it.
 */

export interface MetaSinkInput {
  readonly brandId: string;
  readonly ticketId: string;
  readonly departmentId: string;
  readonly messageId: string;
  readonly contactId: string;
  /** The account whose token the fetch uses. */
  readonly accountId: string;
  readonly refs: readonly MetaFileRef[];
  readonly ids: readonly string[];
  /**
   * Meta has already said these files cannot be served (an `errors[]` on the
   * message, a story that expired): record them rejected with this reason and
   * fetch nothing.
   */
  readonly refusal?: AttachmentRejectReason;
}

/** What the router needs of a sink, so the router is tested without a database. */
export interface MetaAttachmentSink {
  store(tx: DbTransaction, input: MetaSinkInput): Promise<void>;
}

/** What a reference says about its file before anyone has fetched it. */
export interface DeclaredFile {
  readonly kind: AttachmentKind;
  /** The type the platform declared, bare; null when the reference declares none (a CDN link). */
  readonly mime: string | null;
  /** The word a file is named by when the platform gave no filename: `voice-note`, `story`. */
  readonly label: string;
}

const WHATSAPP_LABELS = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
} as const;

/**
 * What Messenger and Instagram call a link's type, as an attachment kind. A
 * story is an image until the server says otherwise (`meta-media.job.ts`).
 */
const CDN_KINDS: Readonly<Record<string, AttachmentKind>> = {
  image: 'image',
  sticker: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
  story: 'image',
  story_mention: 'image',
};

export const declaredFile = (ref: MetaFileRef): DeclaredFile => {
  if (ref.kind === 'whatsapp_media') {
    const mime = bareMime(ref.mimeType);
    return {
      // A photo sent as a "document" is still a photo, as it is for mail.
      kind: kindForMime(mime),
      mime,
      label: ref.voice === true ? 'voice-note' : WHATSAPP_LABELS[ref.type],
    };
  }

  return {
    kind: CDN_KINDS[ref.type] ?? 'file',
    mime: null,
    label: ref.type.replaceAll('_', '-'),
  };
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
};

/**
 * A name for a file the platform sent without one, with the extension its type
 * suggests. Never built from the CDN link: it carries Meta's signature in its
 * query and nothing a person would recognise.
 */
export const metaFileName = (ref: MetaFileRef, mime: string | null): string => {
  if (ref.kind === 'whatsapp_media' && ref.filename !== undefined && ref.filename !== '') {
    return safeFileName(ref.filename);
  }
  const { label } = declaredFile(ref);
  const extension = mime === null ? undefined : EXTENSIONS[mime];

  return extension === undefined ? label : `${label}.${extension}`;
};

/** The reason the policy refuses what the reference declares, or null when it allows it. */
const refusalFor = (
  policy: ContentPolicy,
  declared: DeclaredFile,
): AttachmentRejectReason | null => {
  try {
    if (declared.mime === null) {
      if (!policyFor(policy, declared.kind).enabled) {
        throw new PolicyRefusal('kind_disabled');
      }
    } else {
      // The size is not in the webhook; the job checks it against the bytes.
      checkUpload(policy, { kind: declared.kind, mime: declared.mime, size: 0 });
    }
    return null;
  } catch (error) {
    if (error instanceof PolicyRefusal) {
      return error.reason;
    }
    /* c8 ignore next -- `checkUpload` throws nothing else. */
    throw error;
  }
};

export class DeferredAttachmentSink implements MetaAttachmentSink {
  readonly #media: MediaRepository;

  constructor(media: MediaRepository) {
    this.#media = media;
  }

  async store(tx: DbTransaction, input: MetaSinkInput): Promise<void> {
    const policy = readContentPolicy(await this.#media.contentPolicy(tx, input.brandId));
    // The composer's cap applies to what a customer sends too, as it does to
    // mail; what is over it is left out.
    const refs = input.refs.slice(0, policy.maxAttachmentsPerMessage);

    for (const [index, ref] of refs.entries()) {
      const id = input.ids[index];
      /* c8 ignore next 3 -- the router hands one id per file. */
      if (id === undefined) {
        continue;
      }
      await this.#storeOne(tx, input, ref, id, policy);
    }
  }

  async #storeOne(
    tx: DbTransaction,
    input: MetaSinkInput,
    ref: MetaFileRef,
    id: string,
    policy: ContentPolicy,
  ): Promise<void> {
    const declared = declaredFile(ref);
    const base = {
      id,
      brandId: input.brandId,
      ticketId: input.ticketId,
      // The trigger confirms it against the ticket, as for every child row.
      departmentId: input.departmentId,
      messageId: input.messageId,
      uploaderType: 'contact' as const,
      uploaderId: input.contactId,
      s3Key: attachmentKey(
        { brandId: input.brandId, ticketId: input.ticketId, attachmentId: id },
        ORIGINAL_VARIANT,
      ),
      originalName: metaFileName(ref, declared.mime),
      mime: declared.mime ?? 'application/octet-stream',
      // Neither platform says how big a file is before it is fetched.
      size: 0,
      kind: declared.kind,
    };

    const reason = input.refusal ?? refusalFor(policy, declared);
    if (reason !== null) {
      await this.#media.insert(tx, {
        ...base,
        status: 'rejected',
        rejectReason: reason,
        processedAt: new Date(),
      });
      return;
    }

    await this.#media.insert(tx, base);
    await enqueueMetaMedia(tx, input.brandId, {
      attachmentId: id,
      accountId: input.accountId,
      ref,
    });
  }
}
