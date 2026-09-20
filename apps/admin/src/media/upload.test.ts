import type { Attachment, ContentPolicy } from '@helpdock/schemas';
import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../auth/http-transport.js';
import {
  HttpAttachmentUploader,
  kindOf,
  type PutObject,
  UploadError,
  wouldAccept,
} from './upload.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const ATTACHMENT = '01937f5e-7e53-7000-8000-00000000000c';

const presigned = {
  attachmentId: ATTACHMENT,
  url: 'https://bucket.test/brands/a/tickets/b/c/original?X-Amz-Signature=abc',
  headers: { 'content-type': 'image/png', 'content-length': '12' },
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

const row: Attachment = {
  id: ATTACHMENT,
  ticketId: TICKET,
  messageId: null,
  uploaderType: 'staff',
  originalName: 'shot.png',
  mime: 'image/png',
  kind: 'image',
  size: 12,
  status: 'processing',
  rejectReason: null,
  scanStatus: 'skipped',
  variants: {},
  createdAt: new Date().toISOString(),
  processedAt: null,
};

const file = (name = 'shot.png', type = 'image/png', size = 12): File =>
  new File([new Uint8Array(size)], name, { type });

interface Harness {
  readonly uploader: HttpAttachmentUploader;
  readonly requests: { method: string; path: string; body: unknown }[];
  readonly puts: Parameters<PutObject>[0][];
}

const harness = (options: { status?: number; body?: unknown } = {}): Harness => {
  const requests: Harness['requests'] = [];
  const puts: Harness['puts'] = [];

  const transport = {
    request: async (method: string, path: string, body?: unknown) => {
      requests.push({ method, path, body });
      return path.endsWith('/presign') ? presigned : (options.body ?? row);
    },
  } as unknown as HttpTransport;

  const put: PutObject = async (request) => {
    puts.push(request);
    request.onProgress?.({ loaded: 12, total: 12, ratio: 1 });
    return options.status ?? 200;
  };

  return { uploader: new HttpAttachmentUploader(transport, put), requests, puts };
};

describe('kindOf', () => {
  it('reads the kind off the MIME type the browser gave the file', () => {
    expect(kindOf('image/png')).toBe('image');
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf('audio/webm')).toBe('audio');
    expect(kindOf('application/pdf')).toBe('file');
    // A browser that offers nothing is not a reason to guess an image.
    expect(kindOf('')).toBe('file');
  });
});

describe('wouldAccept', () => {
  const policy = (overrides: Partial<ContentPolicy> = {}): ContentPolicy => ({
    ...DEFAULT_CONTENT_POLICY,
    ...overrides,
  });

  it('accepts a file the brand allows', () => {
    expect(wouldAccept(policy(), { type: 'image/png', size: 1_024 })).toEqual({ ok: true });
  });

  it('refuses a kind that is off, a type that is not allowed, and a file that is too big', () => {
    expect(
      wouldAccept(policy({ video: { enabled: false, maxBytes: 1, allowedMime: ['video/mp4'] } }), {
        type: 'video/mp4',
        size: 1,
      }),
    ).toEqual({ ok: false, problem: 'kind_disabled' });

    expect(wouldAccept(policy(), { type: 'image/svg+xml', size: 1 })).toEqual({
      ok: false,
      problem: 'mime_not_allowed',
    });

    expect(wouldAccept(policy(), { type: 'image/png', size: 11 * 1_048_576 })).toEqual({
      ok: false,
      problem: 'too_large',
    });
  });

  it('is a courtesy and not a check: the same rules run on the server', () => {
    // Which is why it can afford to be case-insensitive about a browser that
    // reports `IMAGE/PNG`.
    expect(wouldAccept(policy(), { type: 'IMAGE/PNG', size: 1 })).toEqual({ ok: true });
  });
});

describe('HttpAttachmentUploader', () => {
  it('presigns, PUTs and confirms, in that order', async () => {
    const { uploader, requests, puts } = harness();

    const attachment = await uploader.upload({ brandId: BRAND, ticketId: TICKET, file: file() });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST /brands/${BRAND}/tickets/${TICKET}/attachments/presign`,
      `POST /brands/${BRAND}/tickets/${TICKET}/attachments/${ATTACHMENT}/confirm`,
    ]);
    expect(puts).toHaveLength(1);
    expect(attachment.id).toBe(ATTACHMENT);
  });

  it('declares the kind, the type, the size and a folded name', async () => {
    const { uploader, requests } = harness();

    await uploader.upload({
      brandId: BRAND,
      ticketId: TICKET,
      file: file('../../etc/passwd', 'image/png', 12),
    });

    expect(requests[0]?.body).toEqual({
      kind: 'image',
      mime: 'image/png',
      size: 12,
      // Folded here as well as on the server, so what a person watches upload
      // is the name that will be stored.
      fileName: 'passwd',
    });
  });

  it('sends the presigned headers verbatim, because they are part of the signature', async () => {
    const { uploader, puts } = harness();

    await uploader.upload({ brandId: BRAND, ticketId: TICKET, file: file() });

    expect(puts[0]?.url).toBe(presigned.url);
    expect(puts[0]?.headers).toEqual(presigned.headers);
  });

  it('reports progress and finishes at one', async () => {
    const { uploader } = harness();
    const onProgress = vi.fn();

    await uploader.upload({ brandId: BRAND, ticketId: TICKET, file: file(), onProgress });

    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 12, total: 12, ratio: 1 });
  });

  it('does not confirm an upload the bucket refused', async () => {
    const { uploader, requests } = harness({ status: 403 });

    await expect(
      uploader.upload({ brandId: BRAND, ticketId: TICKET, file: file() }),
    ).rejects.toBeInstanceOf(UploadError);

    // A confirm after a failed PUT would HEAD an object that is not there and
    // mark the row `object_missing` for no reason.
    expect(requests).toHaveLength(1);
  });

  it('carries the bucket’s status on the error, for a bug report and not for a screen', async () => {
    const { uploader } = harness({ status: 500 });

    const error = await uploader
      .upload({ brandId: BRAND, ticketId: TICKET, file: file() })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as UploadError);

    expect(error?.problem).toBe('upload_failed');
    expect(error?.status).toBe(500);
  });

  it('reads a row back through the download endpoint', async () => {
    const { uploader, requests } = harness({
      body: {
        attachment: { ...row, status: 'ready' },
        variant: 'webp',
        url: 'https://bucket.test/webp',
        expiresAt: new Date().toISOString(),
      },
    });

    const attachment = await uploader.status(BRAND, TICKET, ATTACHMENT);

    expect(attachment.status).toBe('ready');
    expect(requests[0]?.path).toBe(`/brands/${BRAND}/tickets/${TICKET}/attachments/${ATTACHMENT}`);
  });
});
