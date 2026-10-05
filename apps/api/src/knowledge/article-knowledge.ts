import { htmlToText } from '@helpdock/ai';
import { aiSettings, type DbTransaction, hcArticleVersions } from '@helpdock/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { KnowledgeRepository } from './knowledge.repository.js';
import { prepareDocument } from './prepare.js';

/**
 * Help center articles as knowledge (M7-03): automatic, with no source to add.
 *
 * One document per published language version, `<articleId>:<locale>`, with
 * the published title and body. Run by the `knowledge` subscriber of the
 * `help_center.*` events in the event's own transaction, so a publish,
 * unpublish, archive or switch to internal reaches the chunks a second or two
 * after the commit (DOMAIN-RULES §5: "within 60 seconds"); a deleted article
 * takes its documents with it by cascade.
 *
 * A chunk copies its version's visibility and records the version's language
 * as `meta.articleLocale`, but retrieval does not trust either: an article
 * chunk takes part only by joining the live version, published and readable
 * by the audience (`retrieval/visibility.ts`). The copy is for the admin's
 * counts.
 */

export interface ArticleSyncCounts {
  readonly written: number;
  readonly removed: number;
}

export const articleExternalId = (articleId: string, locale: string): string =>
  `${articleId}:${locale}`;

const injectionFilterOf = async (tx: DbTransaction, brandId: string): Promise<boolean> => {
  const [row] = await tx
    .select({ injectionFilter: aiSettings.injectionFilter })
    .from(aiSettings)
    .where(eq(aiSettings.brandId, brandId))
    .limit(1);
  return row?.injectionFilter ?? true;
};

/** `articleIds` absent: every article of the brand, which is the hourly reconcile. */
export const syncArticleKnowledge = async (
  tx: DbTransaction,
  brandId: string,
  articleIds?: readonly string[],
  repository: KnowledgeRepository = new KnowledgeRepository(),
): Promise<ArticleSyncCounts> => {
  if (articleIds?.length === 0) {
    return { written: 0, removed: 0 };
  }
  const source = await repository.articleSource(tx, brandId);
  const injectionFilter = await injectionFilterOf(tx, brandId);
  const versions = await tx
    .select({
      articleId: hcArticleVersions.articleId,
      locale: hcArticleVersions.locale,
      status: hcArticleVersions.status,
      visibility: hcArticleVersions.visibility,
      title: sql<string>`coalesce(${hcArticleVersions.publishedTitle}, ${hcArticleVersions.title})`,
      body: sql<string>`coalesce(${hcArticleVersions.publishedBodyHtml}, '')`,
    })
    .from(hcArticleVersions)
    .where(
      articleIds === undefined ? undefined : inArray(hcArticleVersions.articleId, [...articleIds]),
    );

  let written = 0;
  const published: string[] = [];
  const unpublished: string[] = [];
  for (const version of versions) {
    const externalId = articleExternalId(version.articleId, version.locale);
    if (version.status !== 'published') {
      unpublished.push(externalId);
      continue;
    }
    published.push(externalId);
    const { text } = htmlToText(version.body);
    const prepared = prepareDocument(
      { title: version.title, parts: [{ text, meta: { articleLocale: version.locale } }] },
      { injectionFilter },
    );
    const outcome = await repository.writeDocument(tx, {
      brandId,
      sourceId: source.id,
      externalId,
      title: version.title,
      url: null,
      articleId: version.articleId,
      contentHash: prepared.contentHash,
      visibility: version.visibility,
      chunks: prepared.chunks,
    });
    await repository.relabelDocument(tx, source.id, externalId, version.visibility);
    if (outcome === 'written') {
      written += 1;
    }
  }

  const removed =
    articleIds === undefined
      ? await repository.removeDocumentsExcept(tx, source.id, published)
      : await repository.removeDocuments(tx, source.id, unpublished);
  await repository.update(tx, source.id, { syncStatus: 'ok', lastSyncedAt: new Date() });
  return { written, removed };
};
