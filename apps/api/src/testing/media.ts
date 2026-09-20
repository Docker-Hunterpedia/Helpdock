import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment as AttachmentRow, DbTransaction } from '@helpdock/db';
import type { JobLogger } from '@helpdock/jobs';
import type { AttachmentKind, AttachmentVariants, ContentPolicy } from '@helpdock/schemas';
import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import sharp from 'sharp';
import type { MediaTools } from '../media/ffmpeg.js';
import type { MediaRepository } from '../media/media.repository.js';
import type { FileScanner, ScanVerdict } from '../media/scanner.js';
import type {
  ObjectHead,
  ObjectStorage,
  PresignedDownload,
  PresignedUpload,
} from '../media/storage.js';
import { ObjectTooLargeError } from '../media/storage.js';

/**
 * Doubles the media suites build on (M1-10). They live here rather than beside
 * one of them because three suites share them, and because
 * `vitest.coverage.config.ts` excludes `src/testing/**`: scaffolding is not
 * behaviour this app has to get right.
 */

/** A bucket on the local filesystem: enough to prove everything but SigV4. */
export class FakeStorage implements ObjectStorage {
  readonly #root: string;
  /** Every key ever deleted, so a suite can assert the original was discarded. */
  readonly removed: string[] = [];

  constructor(root: string) {
    this.#root = root;
  }

  #path(key: string): string {
    // The real keys are uuids and variant names; flattening is enough here and
    // keeps the double from needing a directory tree.
    return path.join(this.#root, key.replaceAll('/', '_'));
  }

  async presignUpload({
    key,
    contentType,
    size,
  }: {
    key: string;
    contentType: string;
    size: number;
  }): Promise<PresignedUpload> {
    return {
      url: `https://bucket.test/${encodeURIComponent(key)}`,
      headers: { 'content-type': contentType, 'content-length': String(size) },
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async presignDownload({ key }: { key: string }): Promise<PresignedDownload> {
    return {
      url: `https://bucket.test/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    try {
      const { size } = await stat(this.#path(key));
      return { size, contentType: undefined };
    } catch {
      return undefined;
    }
  }

  async download(key: string, to: string, maxBytes: number): Promise<void> {
    const from = this.#path(key);
    const { size } = await stat(from);
    if (size > maxBytes) {
      throw new ObjectTooLargeError(key, maxBytes);
    }
    await copyFile(from, to);
  }

  async upload({ key, path: from }: { key: string; path: string }): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await copyFile(from, this.#path(key));
  }

  async remove(key: string): Promise<void> {
    this.removed.push(key);
  }

  /** What is in the bucket at a key, for a suite that wants to look at bytes. */
  async read(key: string): Promise<Buffer> {
    return readFile(this.#path(key));
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await writeFile(this.#path(key), bytes);
  }
}

/**
 * ffmpeg, without ffmpeg.
 *
 * The Opus output is a marker file, because nothing downstream decodes it. The
 * poster frame is a *real* PNG, because the worker hands it to sharp on the way
 * to WebP — a marker there would test the double rather than the pipeline. The
 * ffmpeg-dependent assertions live in `media/ffmpeg.integration.test.ts`.
 */
export const FAKE_DURATION_MS = 1_500;

export const fakeTools = (overrides: Partial<MediaTools> = {}): MediaTools => ({
  toOpus: async ({ output }) => {
    await writeFile(output, Buffer.from('OggS fake opus'));
  },
  posterFrame: async ({ output }) => {
    await sharp({ create: { width: 320, height: 240, channels: 3, background: '#101010' } })
      .png()
      .toFile(output);
  },
  durationMs: async () => FAKE_DURATION_MS,
  ...overrides,
});

export const fakeScanner = (verdict: ScanVerdict): FileScanner => ({
  scan: async () => verdict,
});

export const silentJobLogger: JobLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface OutboxRow {
  readonly brandId: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/**
 * A transaction that only knows how to take an outbox row, which is the one
 * statement the processor makes through `tx` rather than through the
 * repository. It records what was written so a suite can assert that the
 * `attachment.ready` event was enqueued with the status it settled on.
 */
export const fakeTx = (written: OutboxRow[]): DbTransaction =>
  ({
    insert: () => ({
      values: (row: OutboxRow) => ({
        returning: async () => {
          written.push(row);
          return [{ id: '01937f5e-7e53-7000-8000-0000000000e1' }];
        },
      }),
    }),
  }) as unknown as DbTransaction;

export interface FakeAttachmentState {
  row: AttachmentRow;
  policy: ContentPolicy;
}

/**
 * A repository over one row in memory, plus the outbox rows the processor
 * writes. The statements themselves are proved against a real Postgres in
 * `media.integration.test.ts`; this is for the decisions around them.
 */
export const fakeRepository = (state: FakeAttachmentState): MediaRepository =>
  ({
    find: async () => state.row,
    contentPolicy: async () => state.policy,
    setStatus: async (_tx: DbTransaction, _id: string, values: Record<string, unknown>) => {
      state.row = { ...state.row, ...values } as AttachmentRow;
      return state.row;
    },
  }) as unknown as MediaRepository;

export const attachmentRow = (overrides: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({
    id: '01937f5e-7e53-7000-8000-00000000000c',
    brandId: '01937f5e-7e53-7000-8000-00000000000a',
    ticketId: '01937f5e-7e53-7000-8000-00000000000b',
    departmentId: '01937f5e-7e53-7000-8000-00000000000d',
    messageId: null,
    uploaderType: 'staff',
    uploaderId: '01937f5e-7e53-7000-8000-000000000001',
    s3Key: 'brands/a/tickets/b/c/original',
    originalName: 'upload.bin',
    mime: 'image/png',
    size: 0,
    kind: 'image' satisfies AttachmentKind,
    status: 'processing',
    rejectReason: null,
    variants: {} satisfies AttachmentVariants,
    scanStatus: 'skipped',
    createdAt: new Date(),
    processedAt: null,
    ...overrides,
  }) as AttachmentRow;

export const policyWith = (overrides: Partial<ContentPolicy> = {}): ContentPolicy => ({
  ...DEFAULT_CONTENT_POLICY,
  ...overrides,
});
