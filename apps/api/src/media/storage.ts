import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '@helpdock/config';

/**
 * The object store, as the rest of the api sees it.
 *
 * **Why it lives in `apps/api` and not in `packages/channels`.** That package
 * is the `ChannelAdapter` seam — email, Telegram, the widget, forms — and a
 * bucket is not a channel; putting it there would make every consumer of the
 * adapters depend on the AWS SDK. Nothing outside the api needs object storage
 * in M1: the presign endpoints, the media worker and the retention purge all
 * run in this process. When M5 gives the help center its public image prefix
 * there will be a second consumer, and moving this file into a `packages/storage`
 * of its own is then a rename — the interface below is already the whole
 * surface.
 *
 * Two rules the bucket is configured around (REQUIREMENTS §5.1, DOMAIN-RULES
 * §4.5):
 *
 * - **The bucket is private.** Nothing here ever sets an ACL, and no code path
 *   returns a bucket URL. Every byte a client reads comes through a presigned
 *   GET this api issued after authorising the caller on the parent ticket.
 * - **Presigned URLs live five minutes.** Long enough for a slow upload of the
 *   caps in the content policy, short enough that a URL in a log, a referrer or
 *   a screenshot is worthless by the time anyone reads it.
 */

/** DOMAIN-RULES §4.5: "URLs live 5 minutes and are bound to the object key." */
export const PRESIGN_TTL_SECONDS = 300;

/** How long a single S3 request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface ObjectHead {
  readonly size: number;
  readonly contentType: string | undefined;
}

export interface PresignedUpload {
  readonly url: string;
  /** Sent verbatim by the client: they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PresignedDownload {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface PresignDownloadOptions {
  readonly key: string;
  readonly contentType: string;
  /** The name the browser saves under. Sanitised before it reaches here. */
  readonly fileName: string;
  /**
   * `false` puts `Content-Disposition: attachment` on the response.
   * REQUIREMENTS §5.1 asks for it on everything that is not an image, because
   * an HTML or SVG payload rendered inline is same-origin script in whatever
   * origin the bucket answers on.
   */
  readonly inline: boolean;
}

/** What the media pipeline needs of a bucket. A test hands the service a double. */
export interface ObjectStorage {
  presignUpload(options: {
    key: string;
    contentType: string;
    size: number;
  }): Promise<PresignedUpload>;
  presignDownload(options: PresignDownloadOptions): Promise<PresignedDownload>;
  /** `undefined` when there is no object at that key. */
  head(key: string): Promise<ObjectHead | undefined>;
  /** Writes the object to `path`, refusing past `maxBytes`. */
  download(key: string, path: string, maxBytes: number): Promise<void>;
  upload(options: { key: string; path: string; contentType: string }): Promise<void>;
  /** Deleting a key that is not there is a success; that is what makes it idempotent. */
  remove(key: string): Promise<void>;
}

/** An object was larger than the caller was prepared to read. */
export class ObjectTooLargeError extends Error {
  constructor(key: string, maxBytes: number) {
    super(`The object at ${key} is larger than the ${maxBytes} bytes allowed for it`);
    this.name = 'ObjectTooLargeError';
  }
}

export type StorageEnv = Pick<
  Env,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
>;

/**
 * The client every caller in this process shares.
 *
 * `forcePathStyle` comes from `S3_FORCE_PATH_STYLE` rather than being guessed
 * from the endpoint: MinIO, Ceph and most self-hosted gateways need it and
 * Amazon S3 does not, and an install that guesses wrong fails with a DNS error
 * that says nothing about why.
 *
 * `S3_ENDPOINT` is a **bootstrap** key — it comes from the operator's `.env`,
 * never from a request or a setting a tenant can edit — so it is not passed
 * through the SSRF-safe client of DOMAIN-RULES §13. That rule governs URLs a
 * *user* supplies; an operator who points their own install at their own
 * network is configuring it, not exploiting it.
 */
export const createS3Client = (env: StorageEnv): S3Client =>
  new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: 5_000 },
  });

/**
 * `Content-Disposition` for a download.
 *
 * The filename is emitted twice: once ASCII-folded for the `filename=` a very
 * old client reads, and once percent-encoded as RFC 5987 `filename*` for
 * everything else. Quotes, backslashes and anything outside printable ASCII are
 * stripped from the first form, so the header can never be closed early or
 * continued onto a second one.
 */
export const contentDisposition = (fileName: string, inline: boolean): string => {
  const ascii = fileName.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName);

  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

export class S3ObjectStorage implements ObjectStorage {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  /**
   * A URL that accepts exactly one object: this key, this content type, this
   * many bytes.
   *
   * `ContentLength` and `ContentType` are *signed*, which is what makes the
   * size cap real. A presigned PUT cannot carry a POST policy's
   * `content-length-range`, but a signed `content-length` is stricter than a
   * range: the bucket recomputes the signature over the headers the request
   * actually arrived with, so a client that sends one more byte than it asked
   * for gets a 403 and nothing is stored. A browser sets `Content-Length`
   * itself from the `File` it is sending and cannot be made to lie about it.
   */
  async presignUpload({
    key,
    contentType,
    size,
  }: {
    key: string;
    contentType: string;
    size: number;
  }): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: size,
    });

    const url = await getSignedUrl(this.#client, command, {
      expiresIn: PRESIGN_TTL_SECONDS,
      signableHeaders: new Set(['content-length', 'content-type']),
    });

    return {
      url,
      headers: { 'content-type': contentType, 'content-length': String(size) },
      expiresAt: expiry(),
    };
  }

  async presignDownload({
    key,
    contentType,
    fileName,
    inline,
  }: PresignDownloadOptions): Promise<PresignedDownload> {
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      // Set on the *response* rather than on the object, so the same stored
      // bytes can be served inline as a thumbnail and as a download by name.
      ResponseContentType: contentType,
      ResponseContentDisposition: contentDisposition(fileName, inline),
    });

    const url = await getSignedUrl(this.#client, command, { expiresIn: PRESIGN_TTL_SECONDS });

    return { url, expiresAt: expiry() };
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );

      return { size: response.ContentLength ?? 0, contentType: response.ContentType };
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Streams the object to disk, stopping the moment it has read more than
   * `maxBytes`.
   *
   * The cap is enforced on the bytes as they arrive and not on the
   * `Content-Length` the response claims: a bucket that is not the one this
   * install thinks it is talking to could claim anything, and the file being
   * written is on the worker's disk.
   */
  async download(key: string, path: string, maxBytes: number): Promise<void> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );

    const body = response.Body;
    if (body === undefined) {
      throw new Error(`The object at ${key} had no body`);
    }

    let read = 0;
    const counted = new Readable({
      read() {
        /* c8 ignore next -- the pipeline below pulls; this is the required stub. */
      },
    });

    const source = body as unknown as AsyncIterable<Uint8Array>;
    const pump = (async (): Promise<void> => {
      for await (const chunk of source) {
        read += chunk.byteLength;
        if (read > maxBytes) {
          throw new ObjectTooLargeError(key, maxBytes);
        }
        counted.push(chunk);
      }
      counted.push(null);
    })();

    // Both are settled before anything is rethrown, and the second rejection is
    // swallowed on purpose. When the cap trips, `pump` rejects and `counted` is
    // destroyed, which makes `pipeline` reject too; leaving that second promise
    // unobserved is an unhandled rejection, and Node ends the worker process on
    // one. The cap firing must stop an upload, not the worker.
    const written = pipeline(counted, createWriteStream(path));
    const [pumped, sunk] = await Promise.allSettled([
      pump.catch((error: unknown) => {
        counted.destroy(error as Error);
        throw error;
      }),
      written,
    ]);

    // The pump's reason is the interesting one — it is the size cap — and the
    // sink's is usually the destroy that followed it.
    const failure =
      pumped.status === 'rejected'
        ? pumped.reason
        : sunk.status === 'rejected'
          ? sunk.reason
          : undefined;

    if (failure !== undefined) {
      // A partial file is worse than none: the next step would sniff it and
      // reject bytes that were merely truncated.
      await rm(path, { force: true });
      throw failure;
    }
  }

  async upload({
    key,
    path,
    contentType,
  }: {
    key: string;
    path: string;
    contentType: string;
  }): Promise<void> {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: handle.createReadStream(),
          ContentType: contentType,
          ContentLength: size,
        }),
      );
    } finally {
      await handle.close();
    }
  }

  async remove(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}

const expiry = (): Date => new Date(Date.now() + PRESIGN_TTL_SECONDS * 1_000);

/**
 * Whether an SDK error means "there is nothing there".
 *
 * `HeadObject` answers 404 with no body, which the SDK surfaces as `NotFound`
 * rather than as `NoSuchKey`; MinIO and Ceph are not always consistent about
 * which, so the status code is checked too.
 */
const isMissing = (error: unknown): boolean => {
  if (error instanceof NotFound || error instanceof NoSuchKey) {
    return true;
  }

  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 404;
};
