import { type DbTransaction, hcImportAssets, hcMedia, importRuns } from '@helpdock/db';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hcMediaKey } from '../help-center/media.service.js';
import { purgeImportFileKeys } from './file-cleanup.js';
import { lockImportBrand } from './jobs/claims.js';

const requestSchema = z.strictObject({
  brandId: z.uuid(),
  cutoff: z.date(),
  limit: z.int().min(1).max(1000),
});

/** Conservative text references protect working/published copies, including copies outside the importing article. */
export async function purgeImportedArticleAssetsBatch(
  tx: DbTransaction,
  raw: z.infer<typeof requestSchema>,
) {
  const { brandId, cutoff, limit } = requestSchema.parse(raw);
  await lockImportBrand(tx, brandId);
  const [active] = await tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, brandId),
        inArray(importRuns.status, [
          'extracting',
          'awaiting_mapping',
          'dry_run',
          'ready',
          'loading',
          'finishing',
          'paused',
        ]),
      ),
    )
    .limit(1);
  if (active) return 0;
  const obsolete = await tx
    .select({ id: hcImportAssets.id })
    .from(hcImportAssets)
    .where(
      and(
        eq(hcImportAssets.brandId, brandId),
        lt(hcImportAssets.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM hc_article_versions v WHERE v.brand_id = ${brandId}::uuid
      AND (strpos(coalesce(v.body_html, '') || coalesce(v.published_body_html, ''), ${hcImportAssets.id}::text) > 0
        OR strpos(coalesce(v.body_html, '') || coalesce(v.published_body_html, ''), ${hcImportAssets.mediaId}::text) > 0))`,
      ),
    )
    .orderBy(hcImportAssets.id)
    .limit(limit)
    .for('update');
  if (obsolete.length)
    await tx.delete(hcImportAssets).where(
      and(
        eq(hcImportAssets.brandId, brandId),
        inArray(
          hcImportAssets.id,
          obsolete.map((asset) => asset.id),
        ),
      ),
    );
  const remaining = limit - obsolete.length;
  if (!remaining) return obsolete.length;
  const orphaned = await tx
    .select({ id: hcMedia.id })
    .from(hcMedia)
    .where(
      and(
        eq(hcMedia.brandId, brandId),
        isNotNull(hcMedia.importedByRunId),
        lt(hcMedia.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM hc_import_assets a WHERE a.brand_id = ${brandId}::uuid AND a.media_id = ${hcMedia.id})`,
        sql`NOT EXISTS (SELECT 1 FROM hc_article_versions v WHERE v.brand_id = ${brandId}::uuid
      AND strpos(coalesce(v.body_html, '') || coalesce(v.published_body_html, ''), ${hcMedia.id}::text) > 0)`,
      ),
    )
    .orderBy(hcMedia.id)
    .limit(remaining)
    .for('update');
  if (!orphaned.length) return obsolete.length;
  // Both the media worker and retention lock the row. A late queued job sees no candidate and cannot PUT after cleanup.
  await purgeImportFileKeys(
    tx,
    brandId,
    orphaned.flatMap(({ id }) => [
      hcMediaKey(brandId, id, 'original'),
      hcMediaKey(brandId, id, 'webp'),
    ]),
  );
  await tx.delete(hcMedia).where(
    and(
      eq(hcMedia.brandId, brandId),
      inArray(
        hcMedia.id,
        orphaned.map((media) => media.id),
      ),
    ),
  );
  return obsolete.length + orphaned.length;
}
