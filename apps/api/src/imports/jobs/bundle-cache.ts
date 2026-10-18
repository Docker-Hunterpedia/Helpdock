import { createHash } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorError, openImportBundleAttachments } from '@helpdock/importers';
import type { ObjectStorage } from '../../media/storage.js';

// One source (at most 2 GiB), one directory index and one active reader per worker.
let current:
  | {
      storage: ObjectStorage;
      key: string;
      directory: string;
      reader: Awaited<ReturnType<typeof openImportBundleAttachments>>;
    }
  | undefined;
let turn = Promise.resolve();
let expiry: ReturnType<typeof setTimeout> | undefined;
const prefix = 'helpdock-import-bundle-cache-';

async function discard() {
  const old = current;
  current = undefined;
  old?.reader.close();
  if (old) await rm(old.directory, { recursive: true, force: true });
}

async function removeAbandoned() {
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const pid = Number(entry.name.slice(prefix.length).split('-')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        await rm(join(tmpdir(), entry.name), { recursive: true, force: true });
    }
  }
}

process.once('exit', () => {
  current?.reader.close();
  if (current) rmSync(current.directory, { recursive: true, force: true });
});

/** Cache identity includes the store, sealed object revision and digest; streams own a serialized lease. */
export async function* cachedBundleAttachment(
  storage: ObjectStorage,
  file: { sourceKey: string; size: number; sha256: string },
  member: string,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  const previous = turn;
  let release = () => {};
  turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  clearTimeout(expiry);
  try {
    signal.throwIfAborted();
    const key = JSON.stringify([file.sourceKey, file.size, file.sha256]);
    if (!current || current.storage !== storage || current.key !== key) {
      await discard();
      await removeAbandoned();
      const directory = await mkdtemp(join(tmpdir(), `${prefix}${process.pid}-`));
      const path = join(directory, 'source');
      try {
        await storage.download(file.sourceKey, path, file.size);
        if ((await stat(path)).size !== file.size) throw new ConnectorError('invalid-response');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) {
          signal.throwIfAborted();
          hash.update(chunk);
        }
        if (hash.digest('hex') !== file.sha256) throw new ConnectorError('invalid-response');
        await chmod(path, 0o400);
        current = {
          storage,
          key,
          directory,
          reader: await openImportBundleAttachments(path, signal),
        };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    yield* current.reader.read(member, signal);
  } finally {
    expiry = setTimeout(() => {
      void discard();
    }, 60000);
    expiry.unref();
    release();
  }
}
