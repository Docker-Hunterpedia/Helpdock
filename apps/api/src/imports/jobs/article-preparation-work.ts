import { type DbTransaction, importLog } from '@helpdock/db';
import type {
  ArticlePreparationRequest,
  ArticlePreparationSnapshot,
} from './article-asset-checkpoint.js';

export type ArticlePreparationTransaction = <T>(
  work: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;

export function articleAssetScope(snapshot: ArticlePreparationSnapshot) {
  return {
    brandId: snapshot.input.claim.brandId,
    source: snapshot.source,
    accountKey: snapshot.accountKey,
    record: snapshot.record,
  };
}

export async function logUnavailableArticleAsset(
  tx: DbTransaction,
  input: ArticlePreparationRequest,
) {
  await tx.insert(importLog).values({
    brandId: input.claim.brandId,
    runId: input.claim.runId,
    entity: 'article',
    externalId: input.record.externalId,
    level: 'warning',
    message: 'import.article.asset-unavailable',
  });
}
