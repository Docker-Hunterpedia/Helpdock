import { brands, type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { importArticleSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { readContentPolicy } from '../../media/content-policy.js';
import { readArticleAssetProof, requireReadyArticleAsset } from '../article-asset-proof.js';
import { importArticleAssetRequests } from '../article-asset-requests.js';
import {
  type ImportArticleAssetOutcome,
  type ImportArticlePreparation,
  importArticleAssetRefusalSchema,
  importArticlePreparationSchema,
} from '../article-asset-state.js';
import { ImportLoadError } from '../loader/contracts.js';
import { ImportClaimLost, importClaimSchema, renewImportClaim } from './claims.js';

export const articlePreparationRequestSchema = z.strictObject({
  claim: importClaimSchema,
  recordId: z.uuid(),
  record: importArticleSchema,
});
export type ArticlePreparationRequest = z.infer<typeof articlePreparationRequestSchema>;

export async function readArticlePreparation(tx: DbTransaction, raw: ArticlePreparationRequest) {
  const input = articlePreparationRequestSchema.parse(raw);
  if (input.claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, input.claim);
  const [row] = await tx
    .select({
      payload: importRecords.payload,
      payloadHash: importRecords.payloadHash,
      externalId: importRecords.externalId,
      status: importRecords.status,
      prepared: importRecords.preparedAssets,
      source: importRuns.source,
      accountKey: importRuns.sourceAccountKey,
      settings: brands.settings,
    })
    .from(importRecords)
    .innerJoin(
      importRuns,
      and(eq(importRuns.id, importRecords.runId), eq(importRuns.brandId, importRecords.brandId)),
    )
    .innerJoin(brands, eq(brands.id, importRecords.brandId))
    .where(
      and(
        eq(importRecords.brandId, input.claim.brandId),
        eq(importRecords.runId, input.claim.runId),
        eq(importRecords.id, input.recordId),
        eq(importRecords.entity, 'article'),
      ),
    )
    .for('update');
  if (!row || row.status !== 'staged') throw new ImportLoadError('target-unavailable');
  const record = importArticleSchema.parse(row.payload);
  if (
    row.externalId !== record.externalId ||
    hashImportValue(record) !== row.payloadHash ||
    hashImportValue(input.record) !== row.payloadHash
  )
    throw new ImportLoadError('mapping-invalid');
  const preparation = importArticlePreparationSchema.parse(
    row.prepared ?? { version: 1, sourceHash: row.payloadHash, outcomes: [] },
  );
  if (preparation.sourceHash !== row.payloadHash) throw new ImportLoadError('mapping-invalid');
  const requests = importArticleAssetRequests(record, input.claim.brandId, row.source);
  const requestKeys = new Set(requests.map((request) => request.key));
  if (preparation.outcomes.some((outcome) => !requestKeys.has(outcome.key)))
    throw new ImportLoadError('mapping-invalid');
  return {
    input,
    source: row.source,
    accountKey: row.accountKey,
    record,
    preparation,
    requests,
    policy: readContentPolicy(row.settings.contentPolicy),
  };
}
export type ArticlePreparationSnapshot = Awaited<ReturnType<typeof readArticlePreparation>>;

function allowedTransition(
  previous: ImportArticleAssetOutcome,
  next: ImportArticleAssetOutcome,
): boolean {
  if (hashImportValue(previous) === hashImportValue(next)) return true;
  if (previous.state !== 'processing') return false;
  return (
    next.state === 'unavailable' || (next.state === 'prepared' && next.assetId === previous.assetId)
  );
}

async function validateOutcome(
  tx: DbTransaction,
  snapshot: ArticlePreparationSnapshot,
  outcome: ImportArticleAssetOutcome,
) {
  const request = snapshot.requests.find((request) => request.key === outcome.key);
  if (!request) throw new ImportLoadError('mapping-invalid');
  const previous = snapshot.preparation.outcomes.find((saved) => saved.key === outcome.key);
  if (previous && !allowedTransition(previous, outcome))
    throw new ImportLoadError('mapping-invalid');
  const scope = {
    brandId: snapshot.input.claim.brandId,
    source: snapshot.source,
    accountKey: snapshot.accountKey,
    record: snapshot.record,
  };
  if (outcome.state !== 'unavailable') {
    const proof = await readArticleAssetProof(tx, scope, request, outcome.assetId);
    if (outcome.state === 'prepared') requireReadyArticleAsset(proof);
    if (outcome.state === 'processing' && proof.media.status === 'rejected')
      throw new ImportLoadError('target-unavailable');
  } else if (previous?.state === 'processing') {
    const proof = await readArticleAssetProof(tx, scope, request, previous.assetId);
    const refusal = importArticleAssetRefusalSchema.safeParse(proof.media.rejectReason);
    if (proof.media.status !== 'rejected' || !refusal.success || refusal.data !== outcome.reason)
      throw new ImportLoadError('target-unavailable');
  }
}

/** Preparation is monotonic: a continuation cannot forget or rewrite a committed source outcome. */
export async function saveArticlePreparation(
  tx: DbTransaction,
  input: ArticlePreparationRequest,
  raw: ImportArticlePreparation,
): Promise<void> {
  const next = importArticlePreparationSchema.parse(raw);
  const current = await readArticlePreparation(tx, input);
  const nextKeys = new Set(next.outcomes.map((outcome) => outcome.key));
  const requestKeys = new Set(current.requests.map((request) => request.key));
  const previous = new Map(current.preparation.outcomes.map((outcome) => [outcome.key, outcome]));
  if (
    next.sourceHash !== current.preparation.sourceHash ||
    current.preparation.outcomes.some((outcome) => !nextKeys.has(outcome.key)) ||
    next.outcomes.some((outcome) => !requestKeys.has(outcome.key)) ||
    (current.preparation.bodyHash !== undefined && current.preparation.bodyHash !== next.bodyHash)
  )
    throw new ImportLoadError('mapping-invalid');
  if (
    next.bodyHash !== undefined &&
    (next.outcomes.length !== current.requests.length ||
      next.outcomes.some((outcome) => outcome.state === 'processing'))
  )
    throw new ImportLoadError('mapping-invalid');
  const sealing = next.bodyHash !== undefined && current.preparation.bodyHash === undefined;
  for (const outcome of next.outcomes) {
    const saved = previous.get(outcome.key);
    if (saved && !allowedTransition(saved, outcome)) throw new ImportLoadError('mapping-invalid');
    if (sealing || !saved || hashImportValue(saved) !== hashImportValue(outcome))
      await validateOutcome(tx, current, outcome);
  }
  await tx
    .update(importRecords)
    .set({ preparedAssets: next })
    .where(
      and(
        eq(importRecords.id, input.recordId),
        eq(importRecords.runId, input.claim.runId),
        eq(importRecords.brandId, input.claim.brandId),
        eq(importRecords.payloadHash, next.sourceHash),
        eq(importRecords.status, 'staged'),
      ),
    );
}
