import { access, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { contentPolicySchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { withPreparedImportFile } from './prepare-file.js';

const policy = contentPolicySchema.parse({});
const signal = () => new AbortController().signal;

it('sniffs downloaded bytes, applies policy, and removes the file after use', async () => {
  const bytes = Buffer.from('%PDF-1.7\nimported history');
  let temporaryPath = '';
  const result = await withPreparedImportFile(
    {
      stream: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
      policy,
      signal: signal(),
      contentType: 'application/octet-stream',
    },
    async (file) => {
      temporaryPath = file.path;
      expect(file).toMatchObject({ mime: 'application/pdf', kind: 'file', size: bytes.length });
      expect(await readFile(file.path)).toEqual(bytes);
      return 'stored';
    },
  );
  expect(result).toBe('stored');
  await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes temporary bytes when storage use fails', async () => {
  let temporaryPath = '';
  await expect(
    withPreparedImportFile(
      {
        stream: Readable.from([Buffer.from('%PDF-1.7\nhistory')]),
        policy,
        signal: signal(),
      },
      async (file) => {
        temporaryPath = file.path;
        throw new Error('storage refused');
      },
    ),
  ).rejects.toThrow('storage refused');
  await expect(access(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('counts actual bytes rather than trusting the declared size', async () => {
  const smallPolicy = contentPolicySchema.parse({
    image: { ...policy.image, maxBytes: 8 },
    video: { ...policy.video, maxBytes: 8 },
    voice: { ...policy.voice, maxBytes: 8 },
    file: { ...policy.file, maxBytes: 8 },
  });
  const stream = Readable.from([Buffer.from('%PDF-'), Buffer.from('more than eight')]);
  await expect(
    withPreparedImportFile(
      {
        stream,
        policy: smallPolicy,
        declaredSize: 1,
        signal: signal(),
      },
      async () => {
        throw new Error('oversized bytes reached storage');
      },
    ),
  ).rejects.toMatchObject({ reason: 'too_large' });
  expect(stream.destroyed).toBe(true);
});

it.each([
  { bytes: Buffer.from('%PDF-1.7\nhistory'), contentType: 'image/png', reason: 'mime_mismatch' },
  { bytes: Buffer.from([0, 1, 255, 0]), contentType: undefined, reason: 'unreadable' },
  { bytes: Buffer.alloc(0), contentType: undefined, reason: 'unreadable' },
])('refuses $reason before bytes reach storage', async ({ bytes, contentType, reason }) => {
  await expect(
    withPreparedImportFile(
      {
        stream: Readable.from([bytes]),
        policy,
        signal: signal(),
        contentType,
      },
      async () => {
        throw new Error('unsafe bytes reached storage');
      },
    ),
  ).rejects.toMatchObject({ reason });
});

it('preserves valid Arabic text bytes', async () => {
  const bytes = Buffer.from('سجل التذكرة الأصلي\nOriginal ticket history');
  await withPreparedImportFile(
    { stream: Readable.from([bytes]), policy, signal: signal() },
    async (file) => {
      expect(file).toMatchObject({ mime: 'text/plain', kind: 'file' });
      expect(await readFile(file.path)).toEqual(bytes);
    },
  );
});

it('refuses a disabled media family before storing downloaded bytes', async () => {
  const bytes = Buffer.from('%PDF-1.7\nhistory');
  await expect(
    withPreparedImportFile(
      {
        stream: Readable.from([bytes]),
        policy: { ...policy, file: { ...policy.file, enabled: false } },
        signal: signal(),
      },
      async () => {
        throw new Error('disabled media reached storage');
      },
    ),
  ).rejects.toMatchObject({ reason: 'kind_disabled' });
});

it('aborts an active download without handing a partial file to storage', async () => {
  const controller = new AbortController();
  const stream = new Readable({
    read() {
      this.push(Buffer.from('%PDF-'));
      controller.abort();
    },
  });
  await expect(
    withPreparedImportFile({ stream, policy, signal: controller.signal }, async () => {
      throw new Error('aborted bytes reached storage');
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(stream.destroyed).toBe(true);
});

it('closes a downloaded stream when its metadata fails boundary validation', async () => {
  const stream = Readable.from([Buffer.from('%PDF-1.7')]);
  await expect(
    withPreparedImportFile({ stream, policy, declaredSize: -1, signal: signal() }, async () => {
      throw new Error('invalid metadata reached storage');
    }),
  ).rejects.toMatchObject({ name: 'ZodError' });
  expect(stream.destroyed).toBe(true);
});
