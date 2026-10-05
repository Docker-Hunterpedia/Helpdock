import { type SQL, sql } from 'drizzle-orm';
import { readableBy } from '../../help-center/visibility.js';

/**
 * Which knowledge chunks an audience may be answered from (DOMAIN-RULES §5),
 * as the `WHERE` clause every retrieval query starts from — the vector one and
 * the full-text one alike, **before** either ranks. There is no post-filter
 * path; `retrieval-sql.test.ts` asserts the clause is in the generated SQL.
 *
 * Both name `knowledge_chunks` as `c` and its source as `s`.
 *
 * - **visitor** (widget, Telegram, email auto-reply, help center search): an
 *   article chunk takes part only by joining its **live** article version,
 *   published, public, and in a help center that is not internal-only — the
 *   chunk's own copy of the flag is not trusted, so an article unpublished a
 *   second ago is already out. Any other chunk needs both its own label and
 *   its source's live visibility to be `public`.
 * - **staff** (agent assist): every chunk of the brand, except an article
 *   chunk whose version is no longer published.
 */

export type RetrievalAudience = 'visitor' | 'staff';

const liveArticleVersion = (audience: RetrievalAudience): SQL => sql`exists (
  select 1 from hc_article_versions
  where hc_article_versions.article_id = c.article_id
    and hc_article_versions.locale::text = c.meta->>'articleLocale'
    and ${readableBy(audience === 'visitor' ? 'public' : 'internal')})`;

export const visibleChunks = (audience: RetrievalAudience): SQL =>
  audience === 'visitor'
    ? sql`((c.article_id is not null and ${liveArticleVersion(audience)})
        or (c.article_id is null and c.visibility = 'public' and s.visibility = 'public'))`
    : sql`(c.article_id is null or ${liveArticleVersion(audience)})`;
