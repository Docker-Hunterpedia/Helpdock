import { open } from 'node:fs/promises';
import path from 'node:path';
import { type DbTransaction, hcMedia } from '@helpdock/db';
import type { AttachmentRejectReason } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { PolicyRefusal } from '../media/content-policy.js';
import { bytesMatchMime, MAGIC_BYTES_PROBE } from '../media/magic-bytes.js';
import type { FileScanner } from '../media/scanner.js';
import { type ObjectStorage, ObjectTooLargeError } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';
import { enqueueImportedHcOriginalCleanup } from './import-media-cleanup.js';
import { HcImportIntegrityRefusal, verifyImportedHcMedia } from './import-media-integrity.js';

export type HcImportFileVerdict =
  | AttachmentRejectReason
  | 'object_missing'
  | 'size_mismatch'
  | 'integrity_mismatch'
  | 'unbound_asset'
  | 'infected';
type MediaRow = typeof hcMedia.$inferSelect;
type Outcome = { status: 'ready' | 'rejected'; reason?: HcImportFileVerdict };

export class HcFileScanUnavailable extends Error {
  constructor() {
    super('help_center.file.scan_unavailable');
    this.name = 'HcFileScanUnavailable';
  }
}

class FileRefused extends Error {
  constructor(readonly reason: HcImportFileVerdict) {
    super(reason);
  }
}

async function verifyFile(tx: DbTransaction, row: MediaRow, file: string) {
  await verifyImportedHcMedia(tx, row, file);
  const handle = await open(file, 'r');
  try {
    const probe = Buffer.alloc(MAGIC_BYTES_PROBE);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (row.mime.startsWith('image/') || !bytesMatchMime(probe.subarray(0, bytesRead), row.mime))
      throw new FileRefused('mime_mismatch');
  } finally {
    await handle.close();
  }
}

/** Raw article files are download-only; source bytes are rechecked before any ready state is published. */
export async function processImportedArticleFile(input: {
  tx: DbTransaction;
  row: MediaRow;
  storage: ObjectStorage;
  scanner?: FileScanner;
}): Promise<Outcome> {
  const { tx, row, storage, scanner } = input;
  try {
    const head = await storage.head(row.s3Key);
    if (!head) throw new FileRefused('object_missing');
    if (head.size !== row.size) throw new FileRefused('size_mismatch');
    const scanStatus = await withTempDir(async (dir) => {
      const file = path.join(dir, 'source');
      await storage.download(row.s3Key, file, 50 * 1024 * 1024);
      await verifyFile(tx, row, file);
      const verdict = scanner ? await scanner.scan(file) : 'skipped';
      if (verdict === 'error') throw new HcFileScanUnavailable();
      return verdict;
    });
    if (scanStatus === 'infected') throw new FileRefused('infected');
    await tx
      .update(hcMedia)
      .set({ status: 'ready', scanStatus, processedAt: new Date() })
      .where(and(eq(hcMedia.brandId, row.brandId), eq(hcMedia.id, row.id)));
    return { status: 'ready' };
  } catch (error) {
    const reason =
      error instanceof FileRefused ||
      error instanceof PolicyRefusal ||
      error instanceof HcImportIntegrityRefusal
        ? error.reason
        : error instanceof ObjectTooLargeError
          ? 'too_large'
          : null;
    if (reason === null) throw error;
    await tx
      .update(hcMedia)
      .set({
        status: 'rejected',
        rejectReason: reason,
        scanStatus: reason === 'infected' ? 'infected' : 'skipped',
        processedAt: new Date(),
      })
      .where(and(eq(hcMedia.brandId, row.brandId), eq(hcMedia.id, row.id)));
    await enqueueImportedHcOriginalCleanup(tx, row);
    return { status: 'rejected', reason };
  }
}
