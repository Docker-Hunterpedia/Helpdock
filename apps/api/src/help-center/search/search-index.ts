import type { DbTransaction } from '@helpdock/db';
import { type SQL, sql } from 'drizzle-orm';

/**
 * Keeps `hc_search_documents` equal to the published help center (M5-05), in
 * the caller's brand transaction.
 *
 * Two statements, each idempotent: remove the row of every version that is no
 * longer published, and write the published text of every published version
 * whose `changed_at` differs from the one its row was built from. Run for one
 * article by the event subscriber, and for the whole brand by the hourly
 * reconcile; either way a repeat changes nothing.
 *
 * Internal versions are indexed like public ones: whether a version may match
 * is the query's decision, made against the live row (`lexical.ts`).
 */

export interface ReindexCounts {
  readonly indexed: number;
  readonly removed: number;
}

const forArticles = (articleIds: readonly string[] | undefined): SQL =>
  articleIds === undefined
    ? sql`true`
    : sql`v.article_id in (${sql.join(
        articleIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;

/** `articleIds` absent: every article of the brand. */
export const reindexArticles = async (
  tx: DbTransaction,
  articleIds?: readonly string[],
): Promise<ReindexCounts> => {
  if (articleIds?.length === 0) {
    return { indexed: 0, removed: 0 };
  }
  const removed = await tx.execute(sql`
    delete from hc_search_documents d
    using hc_article_versions v
    where v.id = d.version_id and v.status <> 'published' and ${forArticles(articleIds)}
    returning d.version_id`);
  const indexed = await tx.execute(sql`
    insert into hc_search_documents
      (version_id, brand_id, article_id, locale, title, description, body_text, source_changed_at)
    select v.id, v.brand_id, v.article_id, v.locale,
      coalesce(v.published_title, v.title), coalesce(v.published_description, ''),
      coalesce(v.published_body_text, ''), v.changed_at
    from hc_article_versions v
    where v.status = 'published' and ${forArticles(articleIds)}
    on conflict (version_id) do update set
      title = excluded.title,
      description = excluded.description,
      body_text = excluded.body_text,
      source_changed_at = excluded.source_changed_at,
      indexed_at = now()
    where hc_search_documents.source_changed_at is distinct from excluded.source_changed_at
    returning version_id`);

  return { indexed: indexed.length, removed: removed.length };
};
