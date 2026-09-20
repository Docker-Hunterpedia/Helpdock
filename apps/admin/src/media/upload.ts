import type {
  Attachment,
  AttachmentKind,
  AttachmentPresignResponse,
  ContentPolicy,
} from '@helpdock/schemas';
import {
  attachmentDownloadSchema,
  attachmentPresignResponseSchema,
  attachmentSchema,
  policyFor,
  safeFileName,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';

/**
 * The client half of the media pipeline (M1-10): presign → PUT → confirm.
 *
 * There is no screen here. M1-15 builds the composer and the thread from the
 * `Admin · ticket view` artboard and calls this; the contract between the two
 * is written down in `apps/admin/README.md` so neither has to read the other's
 * code to know what it gets.
 *
 * Three things it does that a plain `fetch` would not:
 *
 * - **It PUTs with `XMLHttpRequest`.** `fetch` has no upload progress in any
 *   shipping browser — `ReadableStream` request bodies need HTTP/2 and are not
 *   universal — and a 50 MB video with no progress bar is a composer that looks
 *   frozen.
 * - **It sends the presigned headers verbatim.** They are part of the
 *   signature, so adding, dropping or rewriting one turns the upload into a 403
 *   from the bucket.
 * - **It never touches the bucket except through that URL.** The key, the
 *   bucket and the credentials are the server's; this only knows a URL it was
 *   handed and an attachment id.
 */

/** What a caller learns while the bytes are going up. */
export interface UploadProgress {
  /** Bytes the browser has handed to the network. */
  readonly loaded: number;
  readonly total: number;
  /** 0–1, or `undefined` while the browser cannot say how big the body is. */
  readonly ratio: number | undefined;
}

export interface UploadAttachmentInput {
  readonly brandId: string;
  readonly ticketId: string;
  readonly file: File;
  /** Called repeatedly during the PUT, and once with `loaded === total` at the end. */
  readonly onProgress?: (progress: UploadProgress) => void;
  /** Aborting it abandons the upload; the `pending` row is swept by retention. */
  readonly signal?: AbortSignal;
}

/** Why an upload did not happen, as a key the caller renders a translated string from. */
export type UploadProblem =
  | 'kind_disabled'
  | 'too_large'
  | 'mime_not_allowed'
  | 'upload_failed'
  | 'cancelled';

export class UploadError extends Error {
  readonly problem: UploadProblem;
  /** The HTTP status, when there was one. Useful in a bug report, not on screen. */
  readonly status: number | undefined;

  constructor(problem: UploadProblem, message: string, status?: number) {
    super(message);
    this.name = 'UploadError';
    this.problem = problem;
    this.status = status;
  }
}

/**
 * Which half of the content policy a file falls under, from its MIME type.
 *
 * The composer uses it to decide what to ask for and to grey a button out
 * before anything is sent; the api decides it again from what was asked for,
 * because a client's opinion is not an authorisation.
 */
export const kindOf = (mime: string): AttachmentKind => {
  // Lower-cased first: a browser is allowed to report `IMAGE/PNG`, and a file
  // that fell through to `file` because of its case would be measured against
  // the wrong half of the policy.
  const type = mime.toLowerCase();

  if (type.startsWith('image/')) {
    return 'image';
  }
  if (type.startsWith('video/')) {
    return 'video';
  }
  if (type.startsWith('audio/')) {
    return 'audio';
  }
  return 'file';
};

/**
 * Whether the brand would accept this file, answered locally.
 *
 * It is a courtesy, not a check: it exists so a composer can refuse a 60 MB
 * video in the file picker instead of after a minute of uploading. The api
 * applies the same rules to the presign request and again to the object.
 */
export const wouldAccept = (
  policy: ContentPolicy,
  file: { readonly type: string; readonly size: number },
): { ok: true } | { ok: false; problem: UploadProblem } => {
  const kind = kindOf(file.type);
  const kindPolicy = policyFor(policy, kind);

  if (!kindPolicy.enabled) {
    return { ok: false, problem: 'kind_disabled' };
  }
  if (!kindPolicy.allowedMime.includes(file.type.toLowerCase())) {
    return { ok: false, problem: 'mime_not_allowed' };
  }
  if (file.size > kindPolicy.maxBytes) {
    return { ok: false, problem: 'too_large' };
  }

  return { ok: true };
};

export interface AttachmentUploader {
  upload(input: UploadAttachmentInput): Promise<Attachment>;
  /** The row as it stands, for a caller polling a placeholder. */
  status(brandId: string, ticketId: string, attachmentId: string): Promise<Attachment>;
}

/**
 * Uploads one file and returns the attachment once the api has accepted the
 * object. The row comes back `processing`; `attachment:changed` on the ticket's
 * socket room, or {@link HttpAttachmentUploader.status}, is what says it is
 * `ready`.
 */
export class HttpAttachmentUploader implements AttachmentUploader {
  readonly #transport: HttpTransport;
  readonly #put: PutObject;

  constructor(transport: HttpTransport = new HttpTransport(), put: PutObject = xhrPut) {
    this.#transport = transport;
    this.#put = put;
  }

  async upload({
    brandId,
    ticketId,
    file,
    onProgress,
    signal,
  }: UploadAttachmentInput): Promise<Attachment> {
    const base = `/brands/${brandId}/tickets/${ticketId}/attachments`;

    const presigned = attachmentPresignResponseSchema.parse(
      await this.#transport.request('POST', `${base}/presign`, {
        kind: kindOf(file.type),
        mime: file.type.toLowerCase(),
        size: file.size,
        // Folded here as well as on the server: what a person sees while the
        // upload is in flight must be the name that will be stored.
        fileName: safeFileName(file.name),
      }),
    );

    await this.#putObject(presigned, file, onProgress, signal);

    return attachmentSchema.parse(
      await this.#transport.request('POST', `${base}/${presigned.attachmentId}/confirm`),
    );
  }

  async status(brandId: string, ticketId: string, attachmentId: string): Promise<Attachment> {
    const response = await this.#transport.request(
      'GET',
      `/brands/${brandId}/tickets/${ticketId}/attachments/${attachmentId}`,
    );

    return attachmentDownloadSchema.parse(response).attachment;
  }

  async #putObject(
    presigned: AttachmentPresignResponse,
    file: File,
    onProgress: ((progress: UploadProgress) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const status = await this.#put({
      url: presigned.url,
      headers: presigned.headers,
      body: file,
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (status < 200 || status >= 300) {
      throw new UploadError(
        'upload_failed',
        `The object store refused the upload with ${status}`,
        status,
      );
    }
  }
}

/** The PUT, as a function, so a test can stand in for the network. */
export type PutObject = (options: {
  url: string;
  headers: Record<string, string>;
  body: Blob;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}) => Promise<number>;

/**
 * `XMLHttpRequest`, for `upload.onprogress` alone.
 *
 * `Content-Length` is deliberately not set: browsers forbid it, and they set it
 * themselves from the `Blob` being sent — which is exactly the value the server
 * signed, so the signature matches and a client that tried to send more bytes
 * than it asked for would not.
 */
export const xhrPut: PutObject = ({ url, headers, body, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url, true);

    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== 'content-length') {
        request.setRequestHeader(name, value);
      }
    }

    request.upload.addEventListener('progress', (event) => {
      onProgress?.({
        loaded: event.loaded,
        total: event.total,
        ratio: event.lengthComputable && event.total > 0 ? event.loaded / event.total : undefined,
      });
    });

    request.addEventListener('load', () => {
      onProgress?.({ loaded: body.size, total: body.size, ratio: 1 });
      resolve(request.status);
    });
    request.addEventListener('error', () => {
      reject(new UploadError('upload_failed', 'The upload could not reach the object store'));
    });
    request.addEventListener('abort', () => {
      reject(new UploadError('cancelled', 'The upload was cancelled'));
    });

    signal?.addEventListener('abort', () => request.abort(), { once: true });
    if (signal?.aborted === true) {
      request.abort();
      return;
    }

    request.send(body);
  });
