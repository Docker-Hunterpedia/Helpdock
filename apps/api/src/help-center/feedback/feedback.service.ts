import {
  type Db,
  type DbTransaction,
  hcArticleFeedback,
  hcArticleVersions,
  hcArticleViews,
  hcSearchLog,
  systemContext,
  withTenant,
} from '@helpdock/db';
import type { HcAudience, HcLocale } from '@helpdock/schemas';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { defaultLocaleOf, nameIn } from '../content-reader.js';
import type { ArticleRef, HelpCenterFeedback, PopularArticle } from '../ports.js';
import { readableVersions } from '../visibility.js';
import { cleanComment, viewDay, visitorHash } from './visitor-key.js';

/**
 * `HelpCenterFeedback` (M5-08): view counts, "Was this helpful?", and the
 * popular list the help center home and the widget show.
 *
 * - **A view** is one row per visitor per article per UTC day; a repeat that
 *   day is a conflict that does nothing. Opened from a search, it also marks
 *   that search's log row as opened, for "Opened a result".
 * - **A vote** is one row per visitor per article version (one language); a
 *   second vote overwrites the first, comment included.
 * - Only a **published** version takes a view or a vote. Whether the caller
 *   may show the article at all — its audience, a preview, a staff visit that
 *   should not count — is the caller's decision, made before it calls.
 *
 * Each call opens its own transaction for the brand as the system principal,
 * for the reason `HelpCenterContentService` gives.
 */

const FEEDBACK_PRINCIPAL = 'help_center.feedback';

/** `popular`'s window. */
export const POPULAR_DAYS = 30;

type ViewInput = Parameters<HelpCenterFeedback['recordView']>[0];
type VoteInput = Parameters<HelpCenterFeedback['recordVote']>[0];

export class HelpCenterFeedbackService implements HelpCenterFeedback {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  recordView(ref: ViewInput): Promise<void> {
    return this.#inBrand(ref.brandId, async (tx) => {
      if ((await publishedVersion(tx, ref)) === undefined) {
        return;
      }
      await tx
        .insert(hcArticleViews)
        .values({
          brandId: ref.brandId,
          articleId: ref.articleId,
          locale: ref.locale,
          visitorHash: visitorHash(ref.brandId, ref.visitorKey),
          day: viewDay(this.#now()),
        })
        .onConflictDoNothing();
      if (ref.searchId !== undefined) {
        await tx
          .update(hcSearchLog)
          .set({ openedAt: this.#now() })
          .where(and(eq(hcSearchLog.id, ref.searchId), isNull(hcSearchLog.openedAt)));
      }
    });
  }

  recordVote(ref: VoteInput): Promise<void> {
    return this.#inBrand(ref.brandId, async (tx) => {
      const versionId = await publishedVersion(tx, ref);
      if (versionId === undefined) {
        return;
      }
      const comment = cleanComment(ref.comment);
      await tx
        .insert(hcArticleFeedback)
        .values({
          brandId: ref.brandId,
          articleId: ref.articleId,
          versionId,
          locale: ref.locale,
          visitorHash: visitorHash(ref.brandId, ref.visitorKey),
          helpful: ref.helpful,
          comment,
        })
        .onConflictDoUpdate({
          target: [hcArticleFeedback.versionId, hcArticleFeedback.visitorHash],
          set: { helpful: ref.helpful, comment, updatedAt: this.#now() },
        });
    });
  }

  popular(query: {
    readonly brandId: string;
    readonly audience: HcAudience;
    readonly locale: HcLocale;
    readonly limit: number;
  }): Promise<readonly PopularArticle[]> {
    return this.#inBrand(query.brandId, async (tx) => {
      const defaultLocale = await defaultLocaleOf(tx, query.brandId);
      const since = viewDay(new Date(this.#now().getTime() - POPULAR_DAYS * 86_400_000));
      const rows = await tx.execute<{
        article_id: string;
        slug: string;
        locale: HcLocale;
        title: string;
        description: string;
        section_names: Readonly<Record<string, string | undefined>>;
      }>(popularSql(query.audience, query.locale, defaultLocale, since, query.limit));

      return rows.map((row) => ({
        articleId: row.article_id,
        slug: row.slug,
        locale: row.locale,
        title: row.title,
        description: row.description,
        sectionTitle: nameIn(row.section_names, query.locale, defaultLocale),
      }));
    });
  }

  #inBrand<T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.#db, systemContext(brandId, FEEDBACK_PRINCIPAL), fn);
  }
}

const publishedVersion = async (
  tx: DbTransaction,
  ref: ArticleRef,
): Promise<string | undefined> => {
  const [row] = await tx
    .select({ id: hcArticleVersions.id })
    .from(hcArticleVersions)
    .where(
      and(
        eq(hcArticleVersions.articleId, ref.articleId),
        eq(hcArticleVersions.locale, ref.locale),
        eq(hcArticleVersions.status, 'published'),
      ),
    )
    .limit(1);
  return row?.id;
};

/**
 * Readable articles by views since `since`, in the reader's language or the
 * default one. An article nobody viewed still ranks, after every viewed one
 * and newest first, so a help center that has just opened still has
 * something to show.
 */
export const popularSql = (
  audience: HcAudience,
  locale: HcLocale,
  defaultLocale: HcLocale,
  since: string,
  limit: number,
) => sql`
  with ${readableVersions(audience)},
  picked as (
    select distinct on (article_id) *
    from readable
    where locale in (${locale}, ${defaultLocale})
    order by article_id, (locale = ${locale}) desc
  ),
  views as (
    select article_id, count(*) as n
    from hc_article_views
    where day >= ${since}::date
    group by article_id
  )
  select p.article_id, a.slug, p.locale, p.title, p.description, s.names as section_names
  from picked p
  join hc_articles a on a.id = p.article_id
  join hc_sections s on s.id = a.section_id
  left join views v on v.article_id = p.article_id
  order by coalesce(v.n, 0) desc, p.published_at desc, p.article_id
  limit ${Math.max(1, Math.min(limit, 50))}`;
