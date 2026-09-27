import type { DbTransaction } from '@helpdock/db';
import {
  HC_INSIGHTS_ARTICLE_ROWS,
  HC_INSIGHTS_ROWS,
  type HcArticleStats,
  type HcInsights,
  type HcInsightsQuery,
  type HcLocale,
  type HcTopSearch,
  type HcZeroResultSearch,
} from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';
import { defaultLocaleOf } from '../content-reader.js';
import { viewDay } from './visitor-key.js';

/**
 * Help center › Insights (M5-08, `Admin/HelpCenter-Settings` board 2): what
 * visitors searched for, what found nothing, and how each article is read and
 * rated, over the last 7, 30 or 90 days and in one language or all.
 *
 * Read in the staff request's transaction under `help_center:read`; every
 * table here is brand-scoped, so row-level security is what keeps it to the
 * brand. Numbers only: no visitor, cookie or address is stored to show.
 */

type SearchRow = {
  readonly query: string;
  readonly locale: HcLocale;
  readonly searches: number | string;
  readonly opened: number | string;
  readonly last_at: Date | string;
};

type ArticleRow = {
  readonly article_id: string;
  readonly title: string | null;
  readonly views: number | string;
  readonly helpful: number | string;
  readonly votes: number | string;
  readonly comments: number | string;
};

const count = (value: number | string): number => Number(value);

/** "Opened a result" as a share, 0 when nothing was searched. */
export const openedRate = (opened: number, searches: number): number =>
  searches === 0 ? 0 : Math.min(1, opened / searches);

/** What every table of the tab is narrowed by. */
interface Period {
  readonly since: Date;
  /** `true`, or the language column equal to the one asked for. */
  readonly inLocale: (column: SQL) => SQL;
}

export class HelpCenterInsightsService {
  async insights(
    tx: DbTransaction,
    brandId: string,
    query: HcInsightsQuery,
    now: Date = new Date(),
  ): Promise<HcInsights> {
    const locale = query.locale ?? null;
    const period: Period = {
      since: new Date(now.getTime() - query.days * 86_400_000),
      inLocale: (column) => (locale === null ? sql`true` : sql`${column}::text = ${locale}`),
    };
    const titleLocale = locale ?? (await defaultLocaleOf(tx, brandId));

    return {
      days: query.days,
      locale,
      topSearches: await topSearches(tx, period),
      zeroResultSearches: await zeroResultSearches(tx, period),
      articles: await articleStats(tx, period, titleLocale, query.sort),
    };
  }
}

const topSearches = async (tx: DbTransaction, period: Period): Promise<HcTopSearch[]> => {
  const rows = await tx.execute<SearchRow>(sql`
    select query, locale::text as locale, count(*) as searches, count(opened_at) as opened,
      max(created_at) as last_at
    from hc_search_log
    where created_at >= ${period.since.toISOString()}::timestamptz
      and ${period.inLocale(sql`locale`)}
    group by query, locale
    order by count(*) desc, query
    limit ${HC_INSIGHTS_ROWS}`);

  return rows.map((row) => ({
    query: row.query,
    locale: row.locale,
    searches: count(row.searches),
    openedRate: openedRate(count(row.opened), count(row.searches)),
  }));
};

const zeroResultSearches = async (
  tx: DbTransaction,
  period: Period,
): Promise<HcZeroResultSearch[]> => {
  const rows = await tx.execute<SearchRow>(sql`
    select query, locale::text as locale, count(*) as searches, 0 as opened,
      max(created_at) as last_at
    from hc_search_log
    where created_at >= ${period.since.toISOString()}::timestamptz and hits = 0
      and ${period.inLocale(sql`locale`)}
    group by query, locale
    order by count(*) desc, max(created_at) desc, query
    limit ${HC_INSIGHTS_ROWS}`);

  return rows.map((row) => ({
    query: row.query,
    locale: row.locale,
    searches: count(row.searches),
    lastSearchedAt: new Date(row.last_at).toISOString(),
  }));
};

/**
 * Views and answers per article in the period. An article's title is its
 * version in the language asked for, else the brand's default, else any.
 * "Least helpful" puts articles nobody answered last.
 */
const articleStats = async (
  tx: DbTransaction,
  period: Period,
  titleLocale: HcLocale,
  sort: HcInsightsQuery['sort'],
): Promise<HcArticleStats[]> => {
  const rows = await tx.execute<ArticleRow>(sql`
    with views as (
      select article_id, count(*) as views
      from hc_article_views
      where day >= ${viewDay(period.since)}::date and ${period.inLocale(sql`locale`)}
      group by article_id
    ),
    votes as (
      select article_id, count(*) filter (where helpful) as helpful, count(*) as votes,
        count(comment) as comments
      from hc_article_feedback
      where updated_at >= ${period.since.toISOString()}::timestamptz
        and ${period.inLocale(sql`locale`)}
      group by article_id
    ),
    stats as (
      select coalesce(v.article_id, f.article_id) as article_id,
        coalesce(v.views, 0) as views, coalesce(f.helpful, 0) as helpful,
        coalesce(f.votes, 0) as votes, coalesce(f.comments, 0) as comments
      from views v
      full join votes f on f.article_id = v.article_id
    )
    select s.*,
      (select coalesce(hv.published_title, hv.title)
        from hc_article_versions hv
        where hv.article_id = s.article_id
        order by (hv.locale::text = ${titleLocale}) desc, hv.locale
        limit 1) as title
    from stats s
    order by ${
      sort === 'least_helpful'
        ? sql`(s.votes = 0), s.helpful::float / nullif(s.votes, 0), s.votes desc, s.views desc`
        : sql`s.views desc, s.votes desc`
    }, s.article_id
    limit ${HC_INSIGHTS_ARTICLE_ROWS}`);

  return rows.map((row) => ({
    articleId: row.article_id,
    title: row.title ?? '',
    views: count(row.views),
    helpful: count(row.helpful),
    votes: count(row.votes),
    comments: count(row.comments),
  }));
};
