import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GraphApiFailure, type GraphClient, graphMediaMetaSchema } from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import {
  type Attachment as AttachmentRow,
  type Db,
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  withSystem,
} from '@helpdock/db';
import {
  createJobProcessor,
  isLastAttempt,
  type JobHandler,
  type JobLogger,
  type MetaMediaFetchPayload,
  metaMediaFetchJob,
} from '@helpdock/jobs';
import {
  type AttachmentKind,
  type AttachmentRejectReason,
  type ContentPolicy,
  META_ERROR_MAX_LENGTH,
  type MetaFileRef,
  policyFor,
} from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { ZodError } from 'zod';
import { bareMime, kindForMime } from '../channels/inbound/attachment-sink.js';
import { enqueueAttachmentReady, enqueueAttachmentUploaded } from '../media/attachment-events.js';
import { checkUpload, PolicyRefusal, readContentPolicy } from '../media/content-policy.js';
import type { MediaRepository } from '../media/media.repository.js';
import type { ObjectStorage } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';
import { declaredFile, metaFileName } from './deferred-sink.js';
import type { GraphClientFactory } from './graph-client-factory.js';
import type { MetaRepository } from './meta.repository.js';

/**
 * `meta.media_fetch` (M10-03, ADR 0025, 6): the bytes of a file a WhatsApp,
 * Messenger or Instagram webhook named but did not carry, handed to the media
 * pipeline as for any upload.
 *
 * ```
 * pending attachment + meta.media outbox row         (the webhook's transaction)
 * relay → this job                                    (jobId = meta.media_fetch.<outbox id>)
 *   whatsapp_media: GET /{media-id} → a URL good for five minutes → download with the token
 *   cdn_url:        download the link, no token
 * check: size, digest (WhatsApp), the type against the content policy
 * put the object at the attachment's key, status = processing, outbox(attachment.uploaded)
 * relay → media.process                               (sniff, re-encode, scan, ffmpeg)
 * ```
 *
 * **A verdict is not an error.** A digest that does not match, a file over the
 * brand's cap, a type the policy does not allow: the attachment becomes
 * `rejected` with a reason and the job *returns*, because a retry could not
 * decide differently. Only a failure that may pass (Graph or the network
 * down, a link that has not propagated, a token being replaced) throws, and
 * BullMQ asks again: five attempts, backing off from 30 s, each starting from a
 * fresh `GET /{media-id}` because a WhatsApp URL lives five minutes. **The last
 * attempt settles instead of throwing**, as `rejected` with the reason that
 * fits, so an attachment is never left `pending` for good. The job's
 * transaction rolls back when it throws, which is why nothing is written
 * before the bytes are in the bucket.
 *
 * | What happened | Attachment | Account |
 * |---|---|---|
 * | the digest differs | `rejected: unreadable` | |
 * | over the cap (declared by Graph or counted on the way in) | `rejected: too_large` | |
 * | the policy refuses the type | `rejected: mime_not_allowed` / `kind_disabled` | |
 * | 404 on the id or the link (expired, not yet there) | retried; the last attempt `rejected: object_missing` | |
 * | the token is dead (`190`) | retried; the last attempt `rejected: processing_failed` | `token_expired` and `last_error` |
 * | the token lacks a permission, the account is restricted | `rejected: processing_failed` | `last_error` |
 * | Graph or the network failed, a rate limit | retried; the last attempt `rejected: processing_failed` | |
 * | the host is not Meta's | `rejected: processing_failed` | |
 *
 * The account is written outside the job's transaction, which a retry rolls
 * back, so the operator sees the dead token at once rather than after the
 * last attempt.
 */

/** How long one download may take. The job holds the brand's transaction for it. */
const META_MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;

/** What a failed fetch tells the account's row. Never the token. */
export interface MetaAccountFailure {
  readonly kind: 'token_dead' | 'other';
  readonly detail: string;
}

export interface MetaMediaFetchDependencies {
  /** Where the bytes go: the same bucket `media.process` reads. */
  readonly storage: Pick<ObjectStorage, 'upload'>;
  readonly graph: GraphClientFactory;
  readonly keyring: Keyring;
  readonly repository: Pick<MetaRepository, 'account'>;
  readonly media: Pick<MediaRepository, 'find' | 'contentPolicy' | 'setStatus'>;
  /** Writes a fact about the account in a transaction of its own (see the note above). */
  readonly recordAccountFailure: (
    brandId: string,
    accountId: string,
    failure: MetaAccountFailure,
  ) => Promise<void>;
  readonly now?: () => Date;
}

/** `recordAccountFailure` over the database: `token_expired` and `last_error` on the row. */
export const accountFailureRecorder =
  (
    db: Db,
    repository: Pick<MetaRepository, 'update'>,
    now: () => Date = () => new Date(),
  ): MetaMediaFetchDependencies['recordAccountFailure'] =>
  (brandId, accountId, failure) =>
    withSystem(db, brandId, async (tx) => {
      const at = now();
      await repository.update(tx, accountId, {
        ...(failure.kind === 'token_dead' ? { status: 'token_expired' as const } : {}),
        lastError: failure.detail.slice(0, META_ERROR_MAX_LENGTH),
        lastErrorAt: at,
      });
    });

// --------------------------------------------------------------------------
// Pure decisions
// --------------------------------------------------------------------------

/**
 * Whether `bytes` are the file Meta described. A WhatsApp webhook carries the
 * SHA-256 in base64 and `GET /{media-id}` in hex; both are read. A value that
 * is neither is a mismatch rather than an error: it is Meta's word against the
 * bytes, and the bytes win.
 */
export const matchesDigest = (bytes: Uint8Array, expected: string): boolean => {
  const actual = createHash('sha256').update(bytes).digest();
  const wanted = /^[0-9a-f]{64}$/i.test(expected)
    ? Buffer.from(expected, 'hex')
    : Buffer.from(expected, 'base64');

  return wanted.length === actual.length && wanted.equals(actual);
};

/**
 * The most a reference may weigh: the brand's cap for its kind. A story is an
 * image or a video until it is fetched, so it gets the larger of the two.
 */
export const sizeCap = (policy: ContentPolicy, ref: MetaFileRef): number => {
  if (isStoryLink(ref)) {
    return Math.max(policyFor(policy, 'image').maxBytes, policyFor(policy, 'video').maxBytes);
  }

  return policyFor(policy, declaredFile(ref).kind).maxBytes;
};

/** A story is an image or a video, and only the server can say which. */
const isStoryLink = (ref: MetaFileRef): boolean =>
  ref.kind === 'cdn_url' && (ref.type === 'story' || ref.type === 'story_mention');

/** Graph says an id or a link does not exist: expired, or not there yet. */
const isMissing = (failure: GraphApiFailure): boolean =>
  failure.status === 404 || (failure.code === 100 && failure.subcode === 33);

/** What a failed attempt comes to: the reason to settle on, or another attempt. */
export type FailureAction =
  | { readonly kind: 'settle'; readonly reason: AttachmentRejectReason }
  | { readonly kind: 'retry' };

const settleOn = (reason: AttachmentRejectReason): FailureAction => ({ kind: 'settle', reason });

/**
 * What to do about a Graph failure. A verdict (too large, a host that is not
 * Meta's) and a refusal no retry fixes (a permission, a restriction, a request
 * Graph rejects) settle at once. A file Meta no longer has, a dead token, and
 * Graph or the network failing are asked for again until the last attempt, which
 * settles: `object_missing` for the first, `processing_failed` for the rest.
 */
export const actionFor = (failure: GraphApiFailure, last: boolean): FailureAction => {
  if (failure.reason === 'too-large') {
    return settleOn('too_large');
  }
  if (failure.reason === 'host-not-allowed' || failure.reason === 'blocked') {
    return settleOn('processing_failed');
  }
  const missing = isMissing(failure);
  const passing =
    missing ||
    failure.kind === 'token_dead' ||
    failure.kind === 'retry' ||
    failure.kind === 'rate_limited';
  if (!passing) {
    return settleOn('processing_failed');
  }

  return last ? settleOn(missing ? 'object_missing' : 'processing_failed') : { kind: 'retry' };
};

/** What the account's row should say about a failure, if anything. */
export const accountFailureOf = (failure: GraphApiFailure): MetaAccountFailure | undefined => {
  if (failure.kind === 'token_dead') {
    return { kind: 'token_dead', detail: failure.detail };
  }

  return failure.kind === 'permission' || failure.kind === 'account_restricted'
    ? { kind: 'other', detail: failure.detail }
    : undefined;
};

interface Fetched {
  readonly bytes: Buffer;
  /** What the server called it; null when it said nothing. WhatsApp's type is the webhook's. */
  readonly contentType: string | null;
}

/** A verdict on the file, reached without asking again. */
class Verdict extends Error {
  readonly reason: AttachmentRejectReason;

  constructor(reason: AttachmentRejectReason) {
    super(`The file is rejected: ${reason}`);
    this.name = 'Verdict';
    this.reason = reason;
  }
}

// --------------------------------------------------------------------------
// The job
// --------------------------------------------------------------------------

export const createMetaMediaFetchHandler =
  (deps: MetaMediaFetchDependencies): JobHandler<MetaMediaFetchPayload> =>
  async ({ payload, brandId, tx, job, log }) => {
    const now = deps.now ?? (() => new Date());
    const row = await deps.media.find(tx, payload.attachmentId);
    if (row === undefined) {
      // The ticket was deleted, or the attachment removed, while the job waited.
      log.info({ attachmentId: payload.attachmentId }, 'the attachment is gone; nothing to fetch');
      return;
    }
    if (row.status !== 'pending') {
      log.info({ attachmentId: row.id, status: row.status }, 'the attachment is already fetched');
      return;
    }

    const settle = async (reason: AttachmentRejectReason): Promise<void> => {
      await deps.media.setStatus(tx, row.id, {
        status: 'rejected',
        rejectReason: reason,
        processedAt: now(),
      });
      await enqueueAttachmentReady(tx, brandId, {
        attachmentId: row.id,
        ticketId: row.ticketId,
        departmentId: row.departmentId,
        status: 'rejected',
      });
    };

    const account = await deps.repository.account(tx, payload.accountId);
    if (account === undefined) {
      // Disconnected since the message was filed: nothing holds the token.
      await settle('processing_failed');
      return;
    }

    const fetching: Fetching = {
      tx,
      brandId,
      row,
      account,
      ref: payload.ref,
      policy: readContentPolicy(await deps.media.contentPolicy(tx, brandId)),
    };
    try {
      await fetchAndHandOver(deps, fetching);
    } catch (error) {
      await onFailure({
        deps,
        error,
        fetching,
        last: isLastAttempt(metaMediaFetchJob, job, undefined),
        log,
        settle,
      });
    }
  };

/** Everything one attempt works on. */
interface Fetching {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly row: AttachmentRow;
  readonly account: MetaAccountRow;
  readonly ref: MetaFileRef;
  readonly policy: ContentPolicy;
}

/** The bytes into the bucket, then the row to `processing` and the event `media.process` waits for. */
const fetchAndHandOver = async (
  deps: MetaMediaFetchDependencies,
  fetching: Fetching,
): Promise<void> => {
  const { tx, brandId, row, ref } = fetching;
  const fetched = await fetchFile(deps, fetching);
  const stored = await checkAndStore(deps, fetching, fetched);
  await deps.media.setStatus(tx, row.id, {
    status: 'processing',
    size: fetched.bytes.length,
    mime: stored.mime,
    kind: stored.kind,
    originalName: metaFileName(ref, stored.mime),
  });
  await enqueueAttachmentUploaded(tx, brandId, { attachmentId: row.id, ticketId: row.ticketId });
};

/**
 * What a failed attempt comes to: a verdict or a settled rejection, or a throw
 * so BullMQ asks again ({@link actionFor}). What Graph said about the account is
 * written first, in a transaction of its own, because a throw rolls this one back.
 */
const onFailure = async ({
  deps,
  error,
  fetching,
  last,
  log,
  settle,
}: {
  readonly deps: MetaMediaFetchDependencies;
  readonly error: unknown;
  readonly fetching: Fetching;
  readonly last: boolean;
  readonly log: JobLogger;
  readonly settle: (reason: AttachmentRejectReason) => Promise<void>;
}): Promise<void> => {
  if (error instanceof Verdict || error instanceof PolicyRefusal) {
    await settle(error.reason);
    return;
  }

  const failure = toFailure(error);
  if (failure === undefined) {
    // Our own storage or database: the next attempt may pass, the last one stops.
    if (!last) {
      throw error;
    }
    log.error({ attachmentId: fetching.row.id, err: error }, 'meta media could not be stored');
    await settle('processing_failed');
    return;
  }

  // Never the link (it carries Meta's signature) and never the token.
  log.warn(
    { attachmentId: fetching.row.id, kind: failure.kind, status: failure.status },
    'meta media could not be fetched',
  );
  const note = accountFailureOf(failure);
  if (note !== undefined) {
    await deps.recordAccountFailure(fetching.brandId, fetching.account.id, note);
  }
  const action = actionFor(failure, last);
  if (action.kind === 'retry') {
    throw failure;
  }
  await settle(action.reason);
};

/** A Graph failure, or undefined for anything else; a Graph answer we cannot read is Graph failing. */
const toFailure = (error: unknown): GraphApiFailure | undefined => {
  if (error instanceof GraphApiFailure) {
    return error;
  }
  if (error instanceof ZodError) {
    return new GraphApiFailure(
      'retry',
      'Graph answered with a media description Helpdock cannot read',
    );
  }
  return undefined;
};

// --------------------------------------------------------------------------
// Fetching and storing
// --------------------------------------------------------------------------

const fetchFile = async (
  deps: MetaMediaFetchDependencies,
  { account, ref, policy }: Fetching,
): Promise<Fetched> => {
  const client: Pick<GraphClient, 'get' | 'download'> = deps.graph();
  const cap = sizeCap(policy, ref);

  if (ref.kind === 'cdn_url') {
    // A Messenger or Instagram attachment is a link in the payload: fetched with
    // no token, from a host the client has checked against Meta's.
    const downloaded = await client.download(ref.url, {
      maxBytes: cap,
      timeoutMs: META_MEDIA_DOWNLOAD_TIMEOUT_MS,
    });
    return { bytes: downloaded.bytes, contentType: downloaded.contentType };
  }

  const token = decryptSecret(account.accessToken, deps.keyring);
  const description = graphMediaMetaSchema.parse(await client.get(`/${ref.mediaId}`, { token }));
  const declaredSize = Number(description.file_size);
  if (Number.isFinite(declaredSize) && declaredSize > cap) {
    // Graph says how big it is before a byte moves.
    throw new Verdict('too_large');
  }
  const downloaded = await client.download(description.url, {
    token,
    maxBytes: cap,
    timeoutMs: META_MEDIA_DOWNLOAD_TIMEOUT_MS,
  });

  // Meta's digest, from the webhook, or from this answer when the webhook had none.
  const expected = ref.sha256 ?? description.sha256 ?? null;
  if (expected !== null && !matchesDigest(downloaded.bytes, expected)) {
    throw new Verdict('unreadable');
  }
  return { bytes: downloaded.bytes, contentType: downloaded.contentType };
};

/**
 * The content policy against the bytes, then the object into the bucket at the
 * key the attachment was filed with, which is where `media.process` reads it.
 * The type is the webhook's for WhatsApp and the server's for a link; the
 * pipeline sniffs the magic bytes against it next.
 */
const checkAndStore = async (
  deps: MetaMediaFetchDependencies,
  { row, ref, policy }: Fetching,
  fetched: Fetched,
): Promise<{ mime: string; kind: AttachmentKind }> => {
  const declared = declaredFile(ref);
  const mime = declared.mime ?? bareMime(fetched.contentType ?? 'application/octet-stream');
  // A story's kind is the server's to say; every other kind was declared.
  const kind = isStoryLink(ref) ? kindForMime(mime) : declared.kind;
  checkUpload(policy, { kind, mime, size: fetched.bytes.length });

  await withTempDir(async (dir) => {
    const file = path.join(dir, 'original');
    await writeFile(file, fetched.bytes);
    await deps.storage.upload({ key: row.s3Key, path: file, contentType: mime });
  });

  return { mime, kind };
};

// --------------------------------------------------------------------------
// The processor
// --------------------------------------------------------------------------

/**
 * `createJobProcessor` around the handler: validates the payload, opens the
 * brand's transaction and claims `meta.media_fetch:<attachment>` before the
 * handler runs, so a second delivery of the job fetches nothing.
 */
export const createMetaMediaFetchProcessor = ({
  db,
  log,
  ...deps
}: MetaMediaFetchDependencies & { readonly db: Db; readonly log: JobLogger }) =>
  createJobProcessor(metaMediaFetchJob, createMetaMediaFetchHandler(deps), { db, log }) as (
    job: Job,
  ) => Promise<void>;
