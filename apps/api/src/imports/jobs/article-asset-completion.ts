import {
  type ArticleAssetProof,
  readArticleAssetProof,
  requireReadyArticleAsset,
} from '../article-asset-proof.js';
import {
  type ImportArticleAssetOutcome,
  ImportArticleAssetsPending,
  importArticleAssetRefusalSchema,
} from '../article-asset-state.js';
import { type PreparedImportArticle, preparedImportArticleHash } from '../article-prepared.js';
import { ImportLoadError } from '../loader/contracts.js';
import {
  type ArticlePreparationSnapshot,
  readArticlePreparation,
  saveArticlePreparation,
} from './article-asset-checkpoint.js';
import { renderPreparedArticle } from './article-asset-render.js';
import {
  type ArticlePreparationTransaction,
  articleAssetScope,
  logUnavailableArticleAsset,
} from './article-preparation-work.js';

export type ArticleMediaJobState = (media: {
  brandId: string;
  mediaId: string;
}) => Promise<string | undefined>;

function completedOutcome(
  proof: ArticleAssetProof,
  pending: Extract<ImportArticleAssetOutcome, { state: 'processing' | 'prepared' }>,
): ImportArticleAssetOutcome {
  if (proof.media.status === 'ready') {
    requireReadyArticleAsset(proof);
    return { ...pending, state: 'prepared' };
  }
  const refusal = importArticleAssetRefusalSchema.safeParse(proof.media.rejectReason);
  if (proof.media.status !== 'rejected' || !refusal.success)
    throw new ImportLoadError('target-unavailable');
  return { key: pending.key, state: 'unavailable', reason: refusal.data };
}

export async function advanceArticleAsset(
  snapshot: ArticlePreparationSnapshot,
  inRun: ArticlePreparationTransaction,
  mediaJobState: ArticleMediaJobState,
): Promise<void> {
  const pending = snapshot.preparation.outcomes.find((outcome) => outcome.state === 'processing');
  if (pending?.state !== 'processing') return;
  const request = snapshot.requests.find((request) => request.key === pending.key);
  if (!request) throw new ImportLoadError('mapping-invalid');
  const proof = await inRun((tx) =>
    readArticleAssetProof(tx, articleAssetScope(snapshot), request, pending.assetId),
  );
  if (proof.media.status === 'processing') {
    const state = await mediaJobState({
      brandId: snapshot.input.claim.brandId,
      mediaId: proof.media.id,
    });
    if (state === 'failed' || state === 'completed') {
      const current = await inRun((tx) =>
        readArticleAssetProof(tx, articleAssetScope(snapshot), request, pending.assetId),
      );
      // Bull can finish after our initial snapshot; only an unchanged processing row is stranded.
      if (current.media.status === 'processing') throw new ImportLoadError('target-unavailable');
    }
    throw new ImportArticleAssetsPending();
  }
  const completed = completedOutcome(proof, pending);
  await inRun(async (tx) => {
    const current = await readArticlePreparation(tx, snapshot.input);
    await saveArticlePreparation(tx, snapshot.input, {
      ...current.preparation,
      outcomes: current.preparation.outcomes.map((outcome) =>
        outcome.key === pending.key ? completed : outcome,
      ),
    });
    if (completed.state === 'unavailable') await logUnavailableArticleAsset(tx, snapshot.input);
  });
  throw new ImportArticleAssetsPending();
}

/** Sealing rechecks every completed resource and is immutable across worker restarts. */
export async function sealPreparedArticle(
  snapshot: ArticlePreparationSnapshot,
  inRun: ArticlePreparationTransaction,
): Promise<string | PreparedImportArticle> {
  const outcomes = new Map(snapshot.preparation.outcomes.map((outcome) => [outcome.key, outcome]));
  const assets = await inRun(async (tx) => {
    const proofs = new Map<string, ArticleAssetProof>();
    for (const request of snapshot.requests) {
      const outcome = outcomes.get(request.key);
      if (outcome?.state !== 'prepared') continue;
      const proof = await readArticleAssetProof(
        tx,
        articleAssetScope(snapshot),
        request,
        outcome.assetId,
      );
      requireReadyArticleAsset(proof);
      proofs.set(request.key, proof);
    }
    return proofs;
  });
  const prepared = renderPreparedArticle(snapshot, assets),
    bodyHash = preparedImportArticleHash(prepared);
  if (snapshot.preparation.bodyHash === undefined)
    await inRun((tx) =>
      saveArticlePreparation(tx, snapshot.input, { ...snapshot.preparation, bodyHash }),
    );
  else if (snapshot.preparation.bodyHash !== bodyHash) throw new ImportLoadError('mapping-invalid');
  return snapshot.record.published === undefined ? prepared.bodyHtml : prepared;
}
