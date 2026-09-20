import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AttachmentVariants } from '@helpdock/schemas';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  attachmentRow,
  FAKE_DURATION_MS,
  FakeStorage,
  fakeRepository,
  fakeScanner,
  fakeTools,
  fakeTx,
  type OutboxRow,
  policyWith,
  silentJobLogger,
} from '../testing/media.js';
import { MediaToolError } from './ffmpeg.js';
import { createMediaProcessor, type ProcessOutcome } from './process.job.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const ATTACHMENT = '01937f5e-7e53-7000-8000-00000000000c';
const KEY = 'brands/a/tickets/b/c/original';

/** A real JPEG with a real EXIF block, so "EXIF is stripped" is a real claim. */
let jpegWithExif: Buffer;
let pngBytes: Buffer;

beforeAll(async () => {
  jpegWithExif = await sharp({
    create: { width: 1_200, height: 800, channels: 3, background: '#4c6ef5' },
  })
    .withExifMerge({
      IFD0: { Copyright: 'Helpdock test', Artist: 'somebody', Software: 'a camera' },
    })
    .jpeg()
    .toBuffer();

  pngBytes = await sharp({
    create: { width: 64, height: 64, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer();
});

interface Harness {
  readonly outcome: ProcessOutcome;
  readonly storage: FakeStorage;
  readonly variants: AttachmentVariants;
  readonly status: string;
  readonly rejectReason: string | null;
  readonly scanStatus: string;
  readonly outbox: OutboxRow[];
}

const process = async (options: {
  bytes: Uint8Array;
  kind?: 'image' | 'audio' | 'video' | 'file';
  mime?: string;
  keepOriginals?: boolean;
  scan?: 'clean' | 'infected' | 'error';
  maxBytes?: number;
  tools?: ReturnType<typeof fakeTools>;
  status?: 'pending' | 'processing' | 'ready';
}): Promise<Harness> => {
  const storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-bucket-')));
  await storage.put(KEY, options.bytes);

  const kind = options.kind ?? 'image';
  const state = {
    row: attachmentRow({
      id: ATTACHMENT,
      brandId: BRAND,
      s3Key: KEY,
      kind,
      mime: options.mime ?? 'image/png',
      status: options.status ?? 'processing',
    }),
    policy: policyWith({
      keepOriginals: options.keepOriginals ?? false,
      ...(options.maxBytes === undefined
        ? {}
        : {
            image: { enabled: true, maxBytes: options.maxBytes, allowedMime: ['image/png'] },
          }),
    }),
  };

  const tools = options.tools ?? fakeTools();
  const outbox: OutboxRow[] = [];
  const processor = createMediaProcessor({
    storage,
    tools,
    scanner: options.scan === undefined ? undefined : fakeScanner(options.scan),
    attachments: fakeRepository(state),
  });

  const outcome = await processor.run({
    payload: { brandId: BRAND, attachmentId: ATTACHMENT },
    tx: fakeTx(outbox),
    log: silentJobLogger,
  });

  return {
    outcome,
    storage,
    variants: (state.row.variants ?? {}) as AttachmentVariants,
    status: state.row.status,
    rejectReason: state.row.rejectReason,
    scanStatus: state.row.scanStatus,
    outbox,
  };
};

describe('images', () => {
  it('re-encodes a JPEG to WebP with two thumbnails and no EXIF', async () => {
    const result = await process({ bytes: jpegWithExif, mime: 'image/jpeg' });

    expect(result.status).toBe('ready');
    expect(Object.keys(result.variants).sort()).toEqual(['thumb320', 'thumb960', 'webp']);

    for (const variant of ['webp', 'thumb320', 'thumb960'] as const) {
      const metadata = await sharp(
        await result.storage.read(
          `brands/${BRAND}/tickets/${attachmentRow().ticketId}/${ATTACHMENT}/${variant}`,
        ),
      ).metadata();

      expect(metadata.format, variant).toBe('webp');
      // "strip EXIF/ICC" (ARCHITECTURE §9). sharp drops metadata unless asked
      // to keep it, and this is the assertion that keeps it that way.
      expect(metadata.exif, variant).toBeUndefined();
      expect(metadata.icc, variant).toBeUndefined();
    }
  });

  it('caps the long edge at 2048 and sizes the thumbnails at 320 and 960', async () => {
    const large = await sharp({
      create: { width: 4_000, height: 2_000, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();

    const result = await process({ bytes: large });

    expect(result.variants.webp?.width).toBe(2048);
    expect(result.variants.thumb960?.width).toBe(960);
    expect(result.variants.thumb320?.width).toBe(320);
  });

  it('does not blow a small image up into a bigger, blurrier one', async () => {
    const result = await process({ bytes: pngBytes });

    expect(result.variants.thumb960?.width).toBe(64);
  });

  it('discards the uploaded bytes, because the re-encoded copy is the safe one', async () => {
    const result = await process({ bytes: pngBytes });

    expect(result.storage.removed).toContain(KEY);
    expect(result.variants.original).toBeUndefined();
  });

  it('keeps the uploaded bytes when the brand asked for them', async () => {
    const result = await process({ bytes: pngBytes, keepOriginals: true });

    expect(result.storage.removed).not.toContain(KEY);
    expect(result.variants.original).toEqual({ mime: 'image/png', size: pngBytes.byteLength });
  });

  it('rejects a file whose magic bytes are not what was declared', async () => {
    const result = await process({ bytes: jpegWithExif, mime: 'image/png' });

    expect(result.status).toBe('rejected');
    expect(result.rejectReason).toBe('mime_mismatch');
    expect(result.outcome).toEqual({ status: 'rejected', reason: 'mime_mismatch' });
  });

  it('rejects a PNG header with nothing decodable behind it', async () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

    const result = await process({ bytes: header });

    expect(result.status).toBe('rejected');
    expect(result.rejectReason).toBe('unreadable');
  });

  it('rejects an object bigger than the brand’s cap, even though confirm let it through', async () => {
    const result = await process({ bytes: pngBytes, maxBytes: 10 });

    expect(result.rejectReason).toBe('too_large');
  });

  it('rejects an empty object', async () => {
    const result = await process({ bytes: new Uint8Array(0) });

    expect(result.rejectReason).toBe('unreadable');
  });

  it('strips the tail of a PNG/JavaScript polyglot by re-encoding it', async () => {
    // The sniff accepts it, because it really is a PNG. What disarms it is
    // sharp: the WebP that comes out has none of the appended bytes
    // (REQUIREMENTS §5.1).
    const polyglot = Buffer.concat([pngBytes, Buffer.from('\n/*ZZZZ*/alert("pwned")')]);

    const result = await process({ bytes: polyglot });
    const webp = await result.storage.read(
      `brands/${BRAND}/tickets/${attachmentRow().ticketId}/${ATTACHMENT}/webp`,
    );

    expect(result.status).toBe('ready');
    expect(webp.includes('alert("pwned")')).toBe(false);
    expect(webp.includes('ZZZZ')).toBe(false);
  });
});

describe('voice notes', () => {
  it('normalises to Opus and records the duration', async () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)]);

    const result = await process({ bytes: ogg, kind: 'audio', mime: 'audio/ogg' });

    expect(result.status).toBe('ready');
    expect(result.variants.opus?.mime).toBe('audio/ogg');
    expect(result.variants.opus?.durationMs).toBe(FAKE_DURATION_MS);
    // The uploaded WebM or MP4 is replaced by what this install encoded.
    expect(result.storage.removed).toContain(KEY);
  });

  it('rejects with `timeout` when ffmpeg ran past its budget', async () => {
    const result = await process({
      bytes: Buffer.from('OggS'),
      kind: 'audio',
      mime: 'audio/ogg',
      tools: fakeTools({
        toOpus: async () => {
          throw new MediaToolError('ffmpeg', '/tmp/helpdock-media-xyz/source: killed', true);
        },
      }),
    });

    expect(result.rejectReason).toBe('timeout');
    // Never the tool's stderr: it quotes the worker's paths.
    expect(result.rejectReason).not.toContain('/tmp');
  });

  it('rejects with `processing_failed` when ffmpeg failed for any other reason', async () => {
    const result = await process({
      bytes: Buffer.from('OggS'),
      kind: 'audio',
      mime: 'audio/ogg',
      tools: fakeTools({
        toOpus: async () => {
          throw new MediaToolError('ffmpeg', 'Invalid data found', false);
        },
      }),
    });

    expect(result.rejectReason).toBe('processing_failed');
  });
});

describe('video', () => {
  it('takes a poster frame and keeps the video as it arrived', async () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);

    const result = await process({ bytes: webm, kind: 'video', mime: 'video/webm' });

    expect(result.status).toBe('ready');
    expect(result.variants.poster?.mime).toBe('image/webp');
    // v1 does not transcode video, so the original is all there is to serve.
    expect(result.storage.removed).not.toContain(KEY);
    expect(result.variants.original).toBeDefined();
  });
});

describe('files', () => {
  it('keeps a PDF as it arrived and skips scanning when no scanner is configured', async () => {
    const pdf = Buffer.from('%PDF-1.7\n% helpdock\n');

    const result = await process({ bytes: pdf, kind: 'file', mime: 'application/pdf' });

    expect(result.status).toBe('ready');
    expect(result.scanStatus).toBe('skipped');
    expect(result.variants.original?.mime).toBe('application/pdf');
    expect(Object.keys(result.variants)).toEqual(['original']);
  });

  it('records a clean scan when one is configured', async () => {
    const result = await process({
      bytes: Buffer.from('%PDF-1.7'),
      kind: 'file',
      mime: 'application/pdf',
      scan: 'clean',
    });

    expect(result.scanStatus).toBe('clean');
    expect(result.status).toBe('ready');
  });

  it('deletes the object and keeps the row when the scanner finds something', async () => {
    const result = await process({
      bytes: Buffer.from('%PDF-1.7'),
      kind: 'file',
      mime: 'application/pdf',
      scan: 'infected',
    });

    expect(result.status).toBe('infected');
    expect(result.rejectReason).toBe('infected');
    expect(result.scanStatus).toBe('infected');
    // The bytes go; the row stays as the record that something was caught.
    expect(result.storage.removed).toContain(KEY);
    expect(result.variants).toEqual({});
  });

  it('rejects rather than passing when a configured scanner could not answer', async () => {
    // An install that asked for scanning and silently got none is worse than
    // one that never asked.
    const result = await process({
      bytes: Buffer.from('%PDF-1.7'),
      kind: 'file',
      mime: 'application/pdf',
      scan: 'error',
    });

    expect(result.status).toBe('rejected');
    expect(result.rejectReason).toBe('scan_error');
  });

  it('accepts a docx, which is a Zip and cannot be told from one by its bytes', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]);

    const result = await process({
      bytes: zip,
      kind: 'file',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(result.status).toBe('ready');
  });
});

describe('the outbox row every outcome leaves', () => {
  it.each([
    ['ready', Buffer.from('%PDF-1.7'), 'file' as const, 'application/pdf'],
    ['rejected', Buffer.from('definitely not a png'), 'image' as const, 'image/png'],
  ])('names the status it settled on (%s)', async (expected, bytes, kind, mime) => {
    const result = await process({ bytes, kind, mime });

    expect(result.outbox).toHaveLength(1);
    expect(result.outbox[0]?.event).toBe('attachment.ready');
    expect(result.outbox[0]?.payload).toMatchObject({
      attachmentId: ATTACHMENT,
      status: expected,
    });
    // The frame carries ids and a status and no URL: a presigned URL is issued
    // to a caller authorised at that moment (DOMAIN-RULES §4.5).
    expect(JSON.stringify(result.outbox[0]?.payload)).not.toContain('http');
  });
});

describe('idempotency', () => {
  it('does nothing for a row another delivery already settled', async () => {
    const result = await process({ bytes: pngBytes, status: 'ready' });

    expect(result.outcome.status).toBe('skipped');
    expect(result.outbox).toEqual([]);
  });

  it('does nothing for a row that has been deleted', async () => {
    const storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-bucket-')));
    const outbox: OutboxRow[] = [];
    const processor = createMediaProcessor({
      storage,
      tools: fakeTools(),
      scanner: undefined,
      attachments: { find: async () => undefined } as never,
    });

    const outcome = await processor.run({
      payload: { brandId: BRAND, attachmentId: ATTACHMENT },
      tx: fakeTx(outbox),
      log: silentJobLogger,
    });

    expect(outcome.status).toBe('skipped');
    expect(outbox).toEqual([]);
  });
});

describe('deadlines', () => {
  it('gives every external call a budget, and states the worst case', async () => {
    const { MEDIA_BUDGET_MS, TIMEOUTS_MS } = await import('./process.job.js');

    // The claim in the module's own comment: sharp is on this list too, because
    // libvips runs outside the event loop and nothing else would stop it.
    expect(Object.keys(TIMEOUTS_MS).sort()).toEqual([
      'audio',
      'ffprobe',
      'image',
      'poster',
      'scan',
    ]);
    for (const budget of Object.values(TIMEOUTS_MS)) {
      expect(budget).toBeGreaterThan(0);
    }

    // The kinds are exclusive, so the bound is the slowest path and not the sum
    // — but it must cover each of them.
    expect(MEDIA_BUDGET_MS).toBeGreaterThanOrEqual(TIMEOUTS_MS.scan);
    expect(MEDIA_BUDGET_MS).toBeGreaterThanOrEqual(
      TIMEOUTS_MS.poster + TIMEOUTS_MS.image + TIMEOUTS_MS.ffprobe,
    );
  });
});

describe('infrastructure failures', () => {
  it('throws rather than rejecting, so the job is retried and the row stays processing', async () => {
    const storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-bucket-')));
    const state = { row: attachmentRow({ id: ATTACHMENT, s3Key: KEY }), policy: policyWith() };
    const processor = createMediaProcessor({
      storage,
      tools: fakeTools(),
      scanner: undefined,
      attachments: fakeRepository(state),
    });

    // Nothing was ever uploaded to the double, so the download fails with an
    // `ENOENT` — which is the shape a bucket that blinked takes.
    await expect(
      processor.run({
        payload: { brandId: BRAND, attachmentId: ATTACHMENT },
        tx: fakeTx([]),
        log: silentJobLogger,
      }),
    ).rejects.toThrow();

    expect(state.row.status).toBe('processing');
  });
});
