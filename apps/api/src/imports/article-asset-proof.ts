import { type DbTransaction, hcImportAssets, hcMedia } from '@helpdock/db';
import type { ImportSource, importArticleSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { hcMediaKey } from '../help-center/media.service.js';
import {
  type ImportArticleAssetRequest,
  importArticleAssetMetadataHash,
} from './article-asset-requests.js';
import { ImportLoadError } from './loader/contracts.js';

export type ArticleAssetScope = {
  brandId: string;
  source: ImportSource;
  accountKey: string;
  record: Pick<z.infer<typeof importArticleSchema>, 'externalId' | 'translationOf' | 'locale'>;
};

/** Asset UUIDs alone cannot prove source ownership or that a file matches the reviewed record. */
export async function readArticleAssetProof(
  tx: DbTransaction,
  scope: ArticleAssetScope,
  request: ImportArticleAssetRequest,
  assetId: string,
) {
  const [proof] = await tx
    .select({ asset: hcImportAssets, media: hcMedia })
    .from(hcImportAssets)
    .innerJoin(
      hcMedia,
      and(eq(hcMedia.brandId, hcImportAssets.brandId), eq(hcMedia.id, hcImportAssets.mediaId)),
    )
    .where(
      and(
        eq(hcImportAssets.id, assetId),
        eq(hcImportAssets.brandId, scope.brandId),
        eq(hcImportAssets.source, scope.source),
        eq(hcImportAssets.sourceAccountKey, scope.accountKey),
        eq(hcImportAssets.parentExternalId, scope.record.translationOf ?? scope.record.externalId),
        eq(hcImportAssets.locale, scope.record.locale),
        eq(hcImportAssets.assetExternalId, request.identity.externalId),
        eq(hcImportAssets.usage, request.usage),
        eq(hcImportAssets.payloadHash, importArticleAssetMetadataHash(request)),
      ),
    );
  if (
    !proof ||
    !proof.media.importedByRunId ||
    (request.usage === 'image' && proof.media.kind !== 'image')
  )
    throw new ImportLoadError('mapping-invalid');
  return proof;
}

export type ArticleAssetProof = Awaited<ReturnType<typeof readArticleAssetProof>>;

/** Only canonical objects that completed the media pipeline may enter an article. */
export function requireReadyArticleAsset(proof: ArticleAssetProof): void {
  const { asset, media } = proof;
  if (
    media.status !== 'ready' ||
    !['clean', 'skipped'].includes(media.scanStatus) ||
    media.s3Key !== hcMediaKey(asset.brandId, media.id, 'original') ||
    (media.kind === 'image' &&
      (media.webpKey !== hcMediaKey(asset.brandId, media.id, 'webp') ||
        media.mime !== 'image/webp')) ||
    (media.kind === 'file' && media.mime.startsWith('image/'))
  )
    throw new ImportLoadError('target-unavailable');
}
