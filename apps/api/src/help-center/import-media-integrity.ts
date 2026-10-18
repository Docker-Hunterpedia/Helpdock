import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { brands, type DbTransaction, hcImportAssets, type hcMedia } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { checkUpload, readContentPolicy } from '../media/content-policy.js';

export type HcImportIntegrityVerdict = 'size_mismatch' | 'unbound_asset' | 'integrity_mismatch';
export class HcImportIntegrityRefusal extends Error {
  constructor(readonly reason: HcImportIntegrityVerdict) {
    super(reason);
  }
}

/** Storage is not the source of truth: compare immutable source bytes before scanning or re-encoding. */
export async function verifyImportedHcMedia(
  tx: DbTransaction,
  row: typeof hcMedia.$inferSelect,
  file: string,
): Promise<void> {
  const size = (await stat(file)).size;
  if (size !== row.size) throw new HcImportIntegrityRefusal('size_mismatch');
  const expected = await tx
    .selectDistinct({ hash: hcImportAssets.contentHash })
    .from(hcImportAssets)
    .where(and(eq(hcImportAssets.brandId, row.brandId), eq(hcImportAssets.mediaId, row.id)))
    .limit(2);
  if (!row.importedByRunId || expected.length !== 1)
    throw new HcImportIntegrityRefusal('unbound_asset');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  if (digest.digest('hex') !== expected[0]?.hash)
    throw new HcImportIntegrityRefusal('integrity_mismatch');
  const [brand] = await tx
    .select({ settings: brands.settings })
    .from(brands)
    .where(eq(brands.id, row.brandId));
  if (!brand) throw new HcImportIntegrityRefusal('unbound_asset');
  const kind = row.mime.startsWith('image/')
    ? 'image'
    : row.mime.startsWith('audio/')
      ? 'audio'
      : row.mime.startsWith('video/')
        ? 'video'
        : 'file';
  checkUpload(readContentPolicy(brand.settings.contentPolicy), { kind, mime: row.mime, size });
}
