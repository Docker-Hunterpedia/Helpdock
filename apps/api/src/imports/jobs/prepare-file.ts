import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type AttachmentKind, contentPolicySchema } from '@helpdock/schemas';
import { z } from 'zod';
import { checkUpload, PolicyRefusal } from '../../media/content-policy.js';
import {
  bytesMatchMime,
  isSniffableMime,
  MAGIC_BYTES_PROBE,
  sniffFamily,
} from '../../media/magic-bytes.js';
import { withTempDir } from '../../media/temp-dir.js';

const optionsSchema = z.strictObject({
  stream: z.instanceof(Readable),
  policy: contentPolicySchema,
  contentType: z.string().max(255).optional(),
  declaredSize: z.number().int().nonnegative().optional(),
  signal: z.instanceof(AbortSignal),
});
type Options = z.input<typeof optionsSchema>;
export type PreparedImportFile = {
  path: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
};
const FAMILY_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  webm: 'video/webm',
  isobmff: 'video/mp4',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  zip: 'application/zip',
  text: 'text/plain',
};

function detectedMime(bytes: Buffer, declared?: string): string {
  const normalized = declared?.split(';')[0]?.trim().toLowerCase();
  if (normalized && isSniffableMime(normalized)) {
    if (!bytesMatchMime(bytes, normalized)) throw new PolicyRefusal('mime_mismatch');
    return normalized;
  }
  const family = sniffFamily(bytes);
  if (family === 'unknown') throw new PolicyRefusal('unreadable');
  return FAMILY_MIME[family];
}

function mediaKind(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

/** The callback must finish using the file before returning; cleanup runs on every outcome. */
export async function withPreparedImportFile<T>(
  request: Options,
  use: (file: PreparedImportFile) => Promise<T>,
): Promise<T> {
  const parsed = optionsSchema.safeParse(request);
  if (!parsed.success) {
    if (request.stream instanceof Readable) request.stream.destroy();
    throw parsed.error;
  }
  const input = parsed.data;
  const cap = Math.min(
    50 * 1024 * 1024,
    Math.max(
      input.policy.image.maxBytes,
      input.policy.video.maxBytes,
      input.policy.voice.maxBytes,
      input.policy.file.maxBytes,
    ),
  );
  if (input.declaredSize !== undefined && input.declaredSize > cap) {
    input.stream.destroy();
    throw new PolicyRefusal('too_large');
  }
  return withTempDir(async (dir) => {
    const filePath = path.join(dir, 'source');
    let size = 0;
    let probe = Buffer.alloc(0);
    const bounded = new Transform({
      decodeStrings: false,
      transform(chunk: unknown, _encoding, done) {
        if (!Buffer.isBuffer(chunk)) return done(new PolicyRefusal('unreadable'));
        size += chunk.length;
        if (size > cap) return done(new PolicyRefusal('too_large'));
        if (probe.length < MAGIC_BYTES_PROBE)
          probe = Buffer.concat([probe, chunk.subarray(0, MAGIC_BYTES_PROBE - probe.length)]);
        done(null, chunk);
      },
    });
    await pipeline(
      input.stream,
      bounded,
      createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
      {
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
      },
    );
    if (size === 0) throw new PolicyRefusal('unreadable');
    const mime = detectedMime(probe, input.contentType);
    const kind = mediaKind(mime);
    checkUpload(input.policy, { kind, mime, size });
    return use({ path: filePath, size, mime, kind });
  });
}
