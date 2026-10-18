import { hcArticleVersions, knowledgeChunks } from '@helpdock/db';
import { sql } from 'drizzle-orm';

/** Read live publication authority, including for jobs queued before an import. */
export function articleEmbeddingEligible() {
  return sql`(${knowledgeChunks.articleId} IS NULL OR EXISTS (
    SELECT 1 FROM ${hcArticleVersions}
    WHERE ${hcArticleVersions.brandId} = ${knowledgeChunks.brandId}
      AND ${hcArticleVersions.articleId} = ${knowledgeChunks.articleId}
      AND ${hcArticleVersions.locale}::text = coalesce(
        ${knowledgeChunks.meta}->>'articleLocale', ${knowledgeChunks.locale})
      AND ${hcArticleVersions.importEmbeddingDeferred} = FALSE
  ))`;
}
