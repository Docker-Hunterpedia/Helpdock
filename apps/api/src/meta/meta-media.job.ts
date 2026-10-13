import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GraphApiFailure, type GraphClient, graphMediaMetaSchema } from '@helpdock/channels';
import type { Keyring } from '@helpdock/config';
import {
  type Db,
  type DbTransaction,
  type MetaAccount as MetaAccountRow,
  withSystem,
} from '@helpdock/db';
import {
  claimReceipt,
  isLastAttempt,
  type JobLogger,
  type MetaMediaFetchPayload,
  metaMediaFetchJob,
  readJob,
} from '@helpdock/jobs';
import {
  type AttachmentKind,
  type AttachmentRejectReason,
  type ContentPolicy,
  type MetaFileRef,
  policyFor,
} from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { ZodError } from 'zod';
import { bareMime, kindForMime } from '../channels/inbound/attachment-sink.js';
import { failureFields } from '../channels/pg-errors.js';
import { enqueueAttachmentReady, enqueueAttachmentUploaded } from '../media/attachment-events.js';
import { checkUpload, PolicyRefusal, readContentPolicy } from '../media/content-policy.js';
import type { MediaRepository } from '../media/media.repository.js';
import type { ObjectStorage } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';
import { graphForAccount } from './account-graph.js';
import { declaredFile, metaFileName } from './deferred-sink.js';
import type { MetaRepository } from './meta.repository.js';
import type { AccountFailureRecorder, MetaAccountFailure } from './meta-account-failure.js';

/**
 * `meta.media_fetch` (M10-03, ADR 0025, 6): the bytes of a file a WhatsApp,
 * Messenger or Instagram webhook named but did not carry, handed to the media
 * pipeline as for any upload.
 *
 * ```
 * pending attachment + meta.media outbox row         (the webhook's transaction)
 * relay → this job                                    (jobId = meta.media_fetch.<outbox id>)
 *   1. a short transaction: is the attachment still pending, the account, the policy
 *   2. no transaction at all:
 *        whatsapp_media: GET /{media-id} → a URL good for five minutes → download with the token
 *        cdn_url:        download the link, no token
 *        check: size, digest (WhatsApp), the type against the content policy; put the object in the bucket
 *   3. a short transaction: claim the receipt, status = processing, outbox(attachment.uploaded)
 * relay → media.process                               (sniff, re-encode, scan, ffmpeg)
 * ```
 *
 * **No database transaction waits on Meta.** The job runs on the `inbound` queue,
 * which email and Telegram polling and the profile lookups share, and a
 * transaction held across a download holds a pooled connection with it, so a
 * burst of media messages could starve every brand's intake. The two
 * transactions are statements wide. A redelivery that races the first run may
 * download the file again, but only one of them claims the receipt and writes.
 * The download keeps the 30 seconds of DOMAIN-RULES §13.
 *
 * **A verdict is not an error.** A digest that does not match, a file over the
 * brand's cap, a type the policy does not allow: the attachment becomes
 * `rejected` with a reason and the job *returns*, because a retry could not
 * decide differently. Only a failure that may pass (Graph or the network
 * down, a link that has not propagated, a token being replaced) throws, and
 * BullMQ asks again: five attempts, backing off from 30 s, each starting from a
 * fresh `GET /{media-id}` because a WhatsApp URL lives five minutes. **The last
 * attempt settles instead of throwing**, as `rejected` with the reason that
 * fits, so an attachment is never left `pending` for good. Nothing is written
 * before the bytes are in the bucket, and a throw writes nothing.
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
 * The account is written in a transaction of its own, so the operator sees the
 * dead token at once rather than after the last attempt.
 */

export interface MetaMediaFetchDependencies {
  /** Where the bytes go: the same bucket `media.process` reads. */
  readonly storage: Pick<ObjectStorage, 'upload'>;
  readonly graph: GraphClient;
  readonly keyring: Keyring;
  readonly repository: Pick<MetaRepository, 'account'>;
  readonly media: Pick<MediaRepository, 'find' | 'contentPolicy' | 'setStatus'>;
  /** A short transaction of the brand's, as the system principal: the job has two. */
  readonly transaction: <T>(brandId: string, work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
  /** Claims the delivery's receipt, in the transaction that writes what the delivery did. */
  readonly claim: (tx: DbTransaction, key: string) => Promise<boolean>;
  /** Writes a fact about the account in a transaction of its own (see the note above). */
  readonly recordAccountFailure: AccountFailureRecorder;
  readonly now?: () => Date;
}

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

/** What one delivery of the job is for. */
export interface MetaMediaFetchRun {
  readonly payload: MetaMediaFetchPayload;
  readonly job: Pick<Job, 'attemptsMade' | 'opts'>;
  readonly log: JobLogger;
  /** The receipt this delivery claims when it writes. */
  readonly receipt: string;
}

/** What the first transaction read: everything an attempt works on. */
interface Fetching {
  readonly brandId: string;
  readonly s3Key: string;
  readonly account: MetaAccountRow;
  readonly ref: MetaFileRef;
  readonly policy: ContentPolicy;
}

/** What an attempt concluded, for the second transaction to write. */
type Conclusion =
  | {
      readonly kind: 'stored';
      readonly size: number;
      readonly mime: string;
      readonly fileKind: AttachmentKind;
      readonly originalName: string;
    }
  | { readonly kind: 'rejected'; readonly reason: AttachmentRejectReason };

/** What the host of a link or a media URL is, for the log: never the path or the signature. */
interface Target {
  host: string | undefined;
}

export const createMetaMediaFetchHandler =
  (deps: MetaMediaFetchDependencies) =>
  async ({ payload, job, log, receipt }: MetaMediaFetchRun): Promise<void> => {
    const { brandId, attachmentId } = payload;
    const conclude = (conclusion: Conclusion): Promise<void> =>
      writeConclusion(deps, { brandId, attachmentId, receipt, log }, conclusion);

    const fetching = await deps.transaction(brandId, (tx) => readFetching(deps, tx, payload, log));
    if (fetching === 'nothing-to-fetch') {
      return;
    }
    if (fetching === 'account-gone') {
      // Disconnected since the message was filed: nothing holds the token.
      await conclude({ kind: 'rejected', reason: 'processing_failed' });
      return;
    }

    const target: Target = { host: undefined };
    try {
      await conclude(await fetchAndStore(deps, fetching, target));
    } catch (error) {
      await onFailure({
        deps,
        error,
        fetching,
        target,
        attachmentId,
        last: isLastAttempt(metaMediaFetchJob, job, undefined),
        log,
        settle: (reason) => conclude({ kind: 'rejected', reason }),
      });
    }
  };

/** The first transaction: what there is to fetch, or why there is nothing. */
const readFetching = async (
  deps: MetaMediaFetchDependencies,
  tx: DbTransaction,
  payload: MetaMediaFetchPayload,
  log: JobLogger,
): Promise<Fetching | 'nothing-to-fetch' | 'account-gone'> => {
  const row = await deps.media.find(tx, payload.attachmentId);
  if (row === undefined) {
    // The ticket was deleted, or the attachment removed, while the job waited.
    log.info({ attachmentId: payload.attachmentId }, 'the attachment is gone; nothing to fetch');
    return 'nothing-to-fetch';
  }
  if (row.status !== 'pending') {
    log.info({ attachmentId: row.id, status: row.status }, 'the attachment is already fetched');
    return 'nothing-to-fetch';
  }
  const account = await deps.repository.account(tx, payload.accountId);
  if (account === undefined) {
    return 'account-gone';
  }

  return {
    brandId: payload.brandId,
    s3Key: row.s3Key,
    account,
    ref: payload.ref,
    policy: readContentPolicy(await deps.media.contentPolicy(tx, payload.brandId)),
  };
};

/**
 * The second transaction: the receipt, then what the attempt concluded. The row
 * is read again, because the download took a while: a redelivery, or a deleted
 * ticket, may have settled it, and what was fetched is then not written.
 */
const writeConclusion = (
  deps: MetaMediaFetchDependencies,
  {
    brandId,
    attachmentId,
    receipt,
    log,
  }: {
    readonly brandId: string;
    readonly attachmentId: string;
    readonly receipt: string;
    readonly log: JobLogger;
  },
  conclusion: Conclusion,
): Promise<void> =>
  deps.transaction(brandId, async (tx) => {
    if (!(await deps.claim(tx, receipt))) {
      log.info(
        { attachmentId, receipt },
        'duplicate delivery ignored; its receipt is already claimed',
      );
      return;
    }
    const row = await deps.media.find(tx, attachmentId);
    if (row === undefined || row.status !== 'pending') {
      log.info({ attachmentId }, 'the attachment was settled while its file was fetched');
      return;
    }

    if (conclusion.kind === 'stored') {
      await deps.media.setStatus(tx, row.id, {
        status: 'processing',
        size: conclusion.size,
        mime: conclusion.mime,
        kind: conclusion.fileKind,
        originalName: conclusion.originalName,
      });
      await enqueueAttachmentUploaded(tx, brandId, {
        attachmentId: row.id,
        ticketId: row.ticketId,
      });
      return;
    }
    await deps.media.setStatus(tx, row.id, {
      status: 'rejected',
      rejectReason: conclusion.reason,
      processedAt: (deps.now ?? (() => new Date()))(),
    });
    await enqueueAttachmentReady(tx, brandId, {
      attachmentId: row.id,
      ticketId: row.ticketId,
      departmentId: row.departmentId,
      status: 'rejected',
    });
  });

/** The bytes into the bucket, outside any transaction, and what the row should say about them. */
const fetchAndStore = async (
  deps: MetaMediaFetchDependencies,
  fetching: Fetching,
  target: Target,
): Promise<Conclusion> => {
  const fetched = await fetchFile(deps, fetching, target);
  const stored = await checkAndStore(deps, fetching, fetched);

  return {
    kind: 'stored',
    size: fetched.bytes.length,
    mime: stored.mime,
    fileKind: stored.kind,
    originalName: metaFileName(fetching.ref, stored.mime),
  };
};

/**
 * What a failed attempt comes to: a verdict or a settled rejection, or a throw
 * so BullMQ asks again ({@link actionFor}). What Graph said about the account is
 * written first, in a transaction of its own.
 */
const onFailure = async ({
  deps,
  error,
  fetching,
  target,
  attachmentId,
  last,
  log,
  settle,
}: {
  readonly deps: MetaMediaFetchDependencies;
  readonly error: unknown;
  readonly fetching: Fetching;
  readonly target: Target;
  readonly attachmentId: string;
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
    // Its class, code and constraint only: a failed query's message quotes what it was writing.
    log.error({ attachmentId, ...failureFields(error) }, 'meta media could not be stored');
    await settle('processing_failed');
    return;
  }

  // The host and why it was refused, so a destination Helpdock would not fetch from leaves a
  // trace; never the link (it carries Meta's signature) and never the token.
  log.warn(
    {
      attachmentId,
      kind: failure.kind,
      status: failure.status,
      reason: failure.reason,
      host: target.host,
    },
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

const hostOf = (url: string): string | undefined => URL.parse(url)?.hostname;

const fetchFile = async (
  deps: MetaMediaFetchDependencies,
  { account, ref, policy }: Fetching,
  target: Target,
): Promise<Fetched> => {
  const graph = graphForAccount(account, deps.keyring, deps.graph);
  const cap = sizeCap(policy, ref);

  if (ref.kind === 'cdn_url') {
    // A Messenger or Instagram attachment is a link in the payload: fetched with
    // no token, from a host the client has checked against Meta's.
    target.host = hostOf(ref.url);
    const downloaded = await graph.downloadLink(ref.url, { maxBytes: cap });
    return { bytes: downloaded.bytes, contentType: downloaded.contentType };
  }

  const description = graphMediaMetaSchema.parse(await graph.get(`/${ref.mediaId}`));
  const declaredSize = Number(description.file_size);
  if (Number.isFinite(declaredSize) && declaredSize > cap) {
    // Graph says how big it is before a byte moves.
    throw new Verdict('too_large');
  }
  target.host = hostOf(description.url);
  const downloaded = await graph.download(description.url, { maxBytes: cap });

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
  { s3Key, ref, policy }: Fetching,
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
    await deps.storage.upload({ key: s3Key, path: file, contentType: mime });
  });

  return { mime, kind };
};

// --------------------------------------------------------------------------
// The processor
// --------------------------------------------------------------------------

/**
 * The handler behind the job's guards (the right job, an id, a payload that
 * parses) with a short transaction of the brand's for each of its two writes
 * and the receipt claimed in the second.
 */
export const createMetaMediaFetchProcessor = ({
  db,
  log,
  ...deps
}: Omit<MetaMediaFetchDependencies, 'transaction' | 'claim'> & {
  readonly db: Db;
  readonly log: JobLogger;
}) => {
  const handler = createMetaMediaFetchHandler({
    ...deps,
    transaction: (brandId, work) => withSystem(db, brandId, work),
    claim: claimReceipt,
  });

  return async (job: Job): Promise<void> => {
    const { payload, key } = readJob(metaMediaFetchJob, job);
    await handler({ payload, job, log, receipt: key });
  };
};
