import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { FakeStorage } from '../../testing/media.js';
import { cachedBundleAttachment } from './bundle-cache.js';

it('downloads and validates a sealed bundle once for repeated attachments and refuses a changed digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helpdock-bundle-test-'));
  class CountingStorage extends FakeStorage {
    downloads = 0;
    override async download(key: string, path: string, maxBytes: number) {
      this.downloads++;
      return super.download(key, path, maxBytes);
    }
  }
  const storage = new CountingStorage(root);
  const path = fileURLToPath(
    new URL(
      '../../../../../packages/importers/fixtures/bundles/article-attachments.zip',
      import.meta.url,
    ),
  );
  const bytes = await readFile(path);
  const file = {
    sourceKey: 'brand/run/sealed.zip',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const signal = new AbortController().signal;
  try {
    await storage.upload({ key: file.sourceKey, path });
    const read = async (sha256 = file.sha256) => {
      const parts: Buffer[] = [];
      for await (const part of cachedBundleAttachment(
        storage,
        { ...file, sha256 },
        'attachments/manual.pdf',
        signal,
      ))
        parts.push(part);
      return Buffer.concat(parts);
    };
    const first = await read();
    expect(first.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await read()).toEqual(first);
    expect(await read()).toEqual(first);
    expect(storage.downloads).toBe(1);
    await expect(read('0'.repeat(64))).rejects.toMatchObject({ code: 'invalid-response' });
    expect(storage.downloads).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
