import { articleImageSources, articleLinkTargets } from '@helpdock/channels';
import { type DbTransaction, hcImportAssets, importRecords } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { hcImportAssetPath, hcMediaPath, importArticleSchema } from '@helpdock/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type ArticleAssetProof,
  readArticleAssetProof,
  requireReadyArticleAsset,
} from '../article-asset-proof.js';
import { articleCopyAssetRequests, importArticleAssetRequests } from '../article-asset-requests.js';
import { importArticlePreparationSchema } from '../article-asset-state.js';
import { preparedImportArticleHash } from '../article-prepared.js';
import { ImportLoadError } from './contracts.js';
import { importSourceAccountKey } from './external-ids.js';
import type { ArticleLoad } from './knowledge-contracts.js';

/** The saved worker manifest, rather than a caller's HTML, proves source-file ownership. */
export async function verifiedArticleAssets(
  tx: DbTransaction,
  input: ArticleLoad,
  sanitizedBody: string,
  sanitizedPublishedBody?: string,
): Promise<{ prepared: boolean; assets: ArticleAssetProof[] }> {
  const requests = importArticleAssetRequests(input.record, input.brandId, input.source);
  const workingLinks = new Set(articleLinkTargets(sanitizedBody));
  const publishedLinks = new Set(articleLinkTargets(sanitizedPublishedBody ?? ''));
  const links = new Set([...workingLinks, ...publishedLinks]);
  const workingKeys = new Set(
    articleCopyAssetRequests(input.record, input.brandId, input.source).map(
      (request) => request.key,
    ),
  );
  const publishedKeys = new Set(
    input.record.published
      ? articleCopyAssetRequests(input.record.published, input.brandId, input.source).map(
          (request) => request.key,
        )
      : [],
  );
  const images = new Set(
    [sanitizedBody, sanitizedPublishedBody ?? ''].flatMap(articleImageSources),
  );
  const prefix = `/api/help-center/brands/${input.brandId}/assets/`;
  if (!requests.length) {
    if ([...links].some((link) => link.startsWith(prefix)))
      throw new ImportLoadError('mapping-invalid');
    return { prepared: false, assets: [] };
  }
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, input.brandId),
        eq(importRecords.runId, input.runId),
        eq(importRecords.entity, 'article'),
        eq(importRecords.externalId, input.record.externalId),
        eq(importRecords.status, 'staged'),
      ),
    )
    .for('update');
  const parsed = importArticlePreparationSchema.safeParse(row?.preparedAssets);
  if (
    !row ||
    !parsed.success ||
    hashImportValue(importArticleSchema.parse(row.payload)) !== row.payloadHash ||
    hashImportValue(input.record) !== row.payloadHash ||
    parsed.data.sourceHash !== row.payloadHash ||
    parsed.data.bodyHash !==
      preparedImportArticleHash({
        bodyHtml: input.preparedBodyHtml,
        ...(input.preparedPublishedBodyHtml === undefined
          ? {}
          : { publishedBodyHtml: input.preparedPublishedBodyHtml }),
      }) ||
    parsed.data.outcomes.length !== requests.length
  )
    throw new ImportLoadError('mapping-invalid');
  const outcomes = new Map(parsed.data.outcomes.map((outcome) => [outcome.key, outcome]));
  const scope = {
    brandId: input.brandId,
    source: input.source,
    accountKey: await importSourceAccountKey(tx, input),
    record: input.record,
  };
  const assets: ArticleAssetProof[] = [];
  const downloadPaths = new Set<string>();
  for (const request of requests) {
    const outcome = outcomes.get(request.key);
    if (!outcome || outcome.state === 'processing') throw new ImportLoadError('mapping-invalid');
    if (outcome.state === 'unavailable') continue;
    const proof = await readArticleAssetProof(tx, scope, request, outcome.assetId);
    requireReadyArticleAsset(proof);
    const path =
      request.usage === 'image'
        ? hcMediaPath(input.brandId, proof.media.id)
        : hcImportAssetPath(input.brandId, proof.asset.id);
    if (!(request.usage === 'image' ? images : links).has(path))
      throw new ImportLoadError('mapping-invalid');
    if (request.usage === 'download') {
      if (
        workingKeys.has(request.key) !== workingLinks.has(path) ||
        publishedKeys.has(request.key) !== publishedLinks.has(path)
      )
        throw new ImportLoadError('mapping-invalid');
      downloadPaths.add(path);
    }
    assets.push(proof);
  }
  if ([...links].some((link) => link.startsWith(prefix) && !downloadPaths.has(link)))
    throw new ImportLoadError('mapping-invalid');
  return { prepared: true, assets };
}

export async function bindArticleAssets(
  tx: DbTransaction,
  assets: ArticleAssetProof[],
  articleId: string,
): Promise<void> {
  for (const { asset } of assets) {
    if (asset.articleId === articleId) continue;
    if (asset.articleId !== null) throw new ImportLoadError('mapping-invalid');
    const [bound] = await tx
      .update(hcImportAssets)
      .set({ articleId })
      .where(
        and(
          eq(hcImportAssets.id, asset.id),
          eq(hcImportAssets.brandId, asset.brandId),
          isNull(hcImportAssets.articleId),
        ),
      )
      .returning({ id: hcImportAssets.id });
    if (!bound) throw new ImportLoadError('mapping-invalid');
  }
}
