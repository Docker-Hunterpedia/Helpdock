import { type DbTransaction, hcImportAssets, hcMedia, uuidv7 } from '@helpdock/db';
import { and, eq, isNull } from 'drizzle-orm';
import { enqueueMediaUploaded } from '../../help-center/events.js';
import { hcMediaKey } from '../../help-center/media.service.js';
import {
  type ImportArticleAssetRequest,
  importArticleAssetMetadataHash,
} from '../article-asset-requests.js';
import { ImportLoadError } from '../loader/contracts.js';
import {
  type ArticlePreparationRequest,
  readArticlePreparation,
  saveArticlePreparation,
} from './article-asset-checkpoint.js';
import type { PreparedImportFile } from './prepare-file.js';

export async function reserveArticleAsset(
  tx: DbTransaction,
  reservation: {
    input: ArticlePreparationRequest;
    request: ImportArticleAssetRequest;
    file: PreparedImportFile;
    contentHash: string;
  },
) {
  const { input, request, file, contentHash } = reservation;
  const snapshot = await readArticlePreparation(tx, input);
  const metadataHash = importArticleAssetMetadataHash(request);
  if (
    !snapshot.requests.some(
      (entry) =>
        entry.key === request.key && importArticleAssetMetadataHash(entry) === metadataHash,
    )
  )
    throw new ImportLoadError('mapping-invalid');
  const [existing] = await tx
    .select({ asset: hcImportAssets, media: hcMedia })
    .from(hcImportAssets)
    .innerJoin(
      hcMedia,
      and(eq(hcMedia.brandId, hcImportAssets.brandId), eq(hcMedia.id, hcImportAssets.mediaId)),
    )
    .where(
      and(
        eq(hcImportAssets.brandId, input.claim.brandId),
        eq(hcImportAssets.source, snapshot.source),
        eq(hcImportAssets.sourceAccountKey, snapshot.accountKey),
        eq(
          hcImportAssets.parentExternalId,
          snapshot.record.translationOf ?? snapshot.record.externalId,
        ),
        eq(hcImportAssets.locale, snapshot.record.locale),
        eq(hcImportAssets.assetExternalId, request.identity.externalId),
        eq(hcImportAssets.usage, request.usage),
        eq(hcImportAssets.payloadHash, metadataHash),
        eq(hcImportAssets.contentHash, contentHash),
      ),
    );
  if (existing && existing.media.status !== 'rejected') {
    // Save the reference while fenced; the next continuation checks the actual media outcome.
    if (!['processing', 'ready'].includes(existing.media.status))
      throw new ImportLoadError('target-unavailable');
    await saveArticlePreparation(tx, input, {
      ...snapshot.preparation,
      outcomes: [
        ...snapshot.preparation.outcomes,
        { key: request.key, state: 'processing', assetId: existing.asset.id },
      ],
    });
    return { state: 'existing' as const };
  }
  // An unbound failed processing attempt may be replaced; content/source identity stays unchanged.
  if (existing && (!existing.media.importedByRunId || existing.asset.articleId !== null))
    throw new ImportLoadError('target-unavailable');
  const mediaId = uuidv7(),
    assetId = existing?.asset.id ?? uuidv7();
  const key = hcMediaKey(input.claim.brandId, mediaId, 'original');
  // Journal the candidate before storage I/O, including crashes between PUT and publication.
  await tx.insert(hcMedia).values({
    id: mediaId,
    brandId: input.claim.brandId,
    importedByRunId: input.claim.runId,
    kind: file.kind === 'image' ? 'image' : 'file',
    purpose: 'article',
    s3Key: key,
    originalName: request.identity.fileName,
    mime: file.mime,
    size: file.size,
  });
  return {
    state: 'reserved' as const,
    mediaId,
    assetId,
    key,
    contentHash,
    metadataHash,
    replacingMediaId: existing?.media.id,
  };
}

export async function publishArticleAsset(
  tx: DbTransaction,
  input: ArticlePreparationRequest,
  request: ImportArticleAssetRequest,
  reserved: Extract<Awaited<ReturnType<typeof reserveArticleAsset>>, { state: 'reserved' }>,
) {
  const snapshot = await readArticlePreparation(tx, input);
  const [media] = await tx
    .update(hcMedia)
    .set({ status: 'processing' })
    .where(
      and(
        eq(hcMedia.brandId, input.claim.brandId),
        eq(hcMedia.id, reserved.mediaId),
        eq(hcMedia.importedByRunId, input.claim.runId),
        eq(hcMedia.status, 'pending'),
      ),
    )
    .returning({ id: hcMedia.id });
  if (!media) throw new ImportLoadError('target-unavailable');
  const asset = {
    id: reserved.assetId,
    brandId: input.claim.brandId,
    source: snapshot.source,
    sourceAccountKey: snapshot.accountKey,
    parentExternalId: snapshot.record.translationOf ?? snapshot.record.externalId,
    locale: snapshot.record.locale,
    assetExternalId: request.identity.externalId,
    usage: request.usage,
    payloadHash: reserved.metadataHash,
    contentHash: reserved.contentHash,
    mediaId: reserved.mediaId,
  };
  if (reserved.replacingMediaId) {
    const [replaced] = await tx
      .update(hcImportAssets)
      .set({ mediaId: reserved.mediaId })
      .where(
        and(
          eq(hcImportAssets.id, reserved.assetId),
          eq(hcImportAssets.brandId, input.claim.brandId),
          eq(hcImportAssets.mediaId, reserved.replacingMediaId),
          isNull(hcImportAssets.articleId),
        ),
      )
      .returning({ id: hcImportAssets.id });
    if (!replaced) throw new ImportLoadError('target-unavailable');
  } else await tx.insert(hcImportAssets).values(asset);
  await enqueueMediaUploaded(tx, input.claim.brandId, media.id);
  await saveArticlePreparation(tx, input, {
    ...snapshot.preparation,
    outcomes: [
      ...snapshot.preparation.outcomes,
      { key: request.key, state: 'processing', assetId: reserved.assetId },
    ],
  });
}
