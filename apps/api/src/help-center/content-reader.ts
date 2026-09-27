import type { DbTransaction } from '@helpdock/db';
import type {
  HcArticleLookup,
  HcAudience,
  HcChangedVersion,
  HcLocale,
  HcSitemapEntry,
  HcTreeCategory,
  HcTreeSection,
} from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';
import { goneFor, readableBy, readableVersions } from './visibility.js';

/**
 * The read side of the help center (M5-01, M5-09): what a reader of the
 * *published* help center may see, for one audience, inside a transaction the
 * caller opened for one brand. `HelpCenterContentService` opens that
 * transaction for callers that have none — the help center pages, the
 * sitemap, search indexing.
 *
 * Every query here begins `with ${readableVersions(audience)}` or filters
 * with `readableBy(audience)` directly, so the visibility rule of DOMAIN-RULES
 * §5 is applied in SQL before anything else (`visibility.ts`).
 *
 * **Locale fallback.** A reader asks in one language; an article missing in it,
 * or not readable in it, is answered in the brand's default language instead,
 * and says so (`fallback: true`). Names of categories and sections fall back
 * the same way.
 */

type Names = Readonly<Record<string, string | undefined>>;

/** The name in `locale`, else in `fallback`, else in any language it has. */
export const nameIn = (names: Names, locale: HcLocale, fallback: HcLocale): string =>
  names[locale] || names[fallback] || Object.values(names).find((name) => name) || '';

const iso = (value: Date | string): string => new Date(value).toISOString();

const localesOf = (value: readonly string[] | string | null): HcLocale[] => {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.replace(/[{}]/g, '').split(',').filter(Boolean)
      : [];
  return [...list].sort() as HcLocale[];
};

export interface ReadScope {
  readonly audience: HcAudience;
  /** What the reader asked for. */
  readonly locale: HcLocale;
  /** The brand's default language, which a missing translation falls back to. */
  readonly defaultLocale: HcLocale;
}

/** The brand's default language. `brands` is global, so it is read by id. */
export const defaultLocaleOf = async (tx: DbTransaction, brandId: string): Promise<HcLocale> => {
  const [row] = await tx.execute<{ locale: HcLocale }>(
    sql`select default_locale::text as locale from brands where id = ${brandId}`,
  );
  return row?.locale ?? 'en';
};

/**
 * One version per article: the reader's language when it is readable, else
 * the default language. `distinct on` keeps the first row per article in the
 * order given, which puts the reader's language first.
 */
const picked = ({ locale, defaultLocale }: ReadScope): SQL => sql`picked as (
  select distinct on (article_id) *
  from readable
  where locale in (${locale}, ${defaultLocale})
  order by article_id, (locale = ${locale}) desc
)`;

type TreeRow = {
  readonly category_id: string;
  readonly category_slug: string;
  readonly category_names: Names;
  readonly category_descriptions: Names;
  readonly section_id: string;
  readonly section_slug: string;
  readonly section_names: Names;
  readonly article_id: string;
  readonly article_slug: string;
  readonly locale: HcLocale;
  readonly title: string;
};

/**
 * Categories → sections → articles the audience may read, in the order staff
 * put them in. A category or section with nothing readable in it is left out,
 * so an internal-only section does not appear on the public help center as an
 * empty heading that still names it.
 */
export const readTree = async (tx: DbTransaction, scope: ReadScope): Promise<HcTreeCategory[]> => {
  const rows = await tx.execute<TreeRow>(sql`
    with ${readableVersions(scope.audience)}, ${picked(scope)}
    select
      c.id as category_id, c.slug as category_slug, c.names as category_names,
      c.descriptions as category_descriptions,
      s.id as section_id, s.slug as section_slug, s.names as section_names,
      a.id as article_id, a.slug as article_slug, p.locale, p.title
    from picked p
    join hc_articles a on a.id = p.article_id
    join hc_sections s on s.id = a.section_id
    join hc_categories c on c.id = s.category_id
    order by c.position, c.id, s.position, s.id, a.position, a.id`);

  const categories: HcTreeCategory[] = [];
  let category: HcTreeCategory | undefined;
  let section: HcTreeSection | undefined;
  const name = (names: Names) => nameIn(names, scope.locale, scope.defaultLocale);

  for (const row of rows) {
    if (category?.id !== row.category_id) {
      category = {
        id: row.category_id,
        slug: row.category_slug,
        name: name(row.category_names),
        description: name(row.category_descriptions),
        sections: [],
      };
      categories.push(category);
      section = undefined;
    }
    if (section?.id !== row.section_id) {
      section = {
        id: row.section_id,
        slug: row.section_slug,
        name: name(row.section_names),
        articles: [],
      };
      category.sections.push(section);
    }
    section.articles.push({
      id: row.article_id,
      slug: row.article_slug,
      title: row.title,
      locale: row.locale,
      fallback: row.locale !== scope.locale,
    });
  }

  return categories;
};

type ArticleRow = {
  readonly id: string;
  readonly slug: string;
  readonly locale: HcLocale;
  readonly visibility: 'public' | 'internal';
  readonly title: string;
  readonly description: string;
  readonly body_html: string;
  readonly published_at: Date | string;
  readonly locales: readonly string[] | string | null;
  readonly section_id: string;
  readonly section_slug: string;
  readonly section_names: Names;
  readonly category_id: string;
  readonly category_slug: string;
  readonly category_names: Names;
};

/**
 * One article by its slug, in the reader's language or the default one — or
 * `gone` when every version the audience could have read is archived (the
 * page answers 410), or `not_found` (404) for a draft, an internal article
 * asked for by a visitor, or a slug nobody wrote.
 */
export const readArticle = async (
  tx: DbTransaction,
  scope: ReadScope,
  slug: string,
): Promise<HcArticleLookup> => {
  const [row] = await tx.execute<ArticleRow>(sql`
    with ${readableVersions(scope.audience)}
    select
      a.id, a.slug, r.locale, r.visibility, r.title, r.description, r.body_html, r.published_at,
      (select array_agg(r2.locale) from readable r2 where r2.article_id = a.id) as locales,
      s.id as section_id, s.slug as section_slug, s.names as section_names,
      c.id as category_id, c.slug as category_slug, c.names as category_names
    from readable r
    join hc_articles a on a.id = r.article_id
    join hc_sections s on s.id = a.section_id
    join hc_categories c on c.id = s.category_id
    where a.slug = ${slug} and r.locale in (${scope.locale}, ${scope.defaultLocale})
    order by (r.locale = ${scope.locale}) desc
    limit 1`);

  if (row === undefined) {
    const [gone] = await tx.execute<{ found: number }>(sql`
      select 1 as found
      from hc_article_versions
      join hc_articles a on a.id = hc_article_versions.article_id
      where a.slug = ${slug} and ${goneFor(scope.audience)}
      limit 1`);
    return gone === undefined ? { state: 'not_found' } : { state: 'gone' };
  }

  const name = (names: Names) => nameIn(names, scope.locale, scope.defaultLocale);

  return {
    state: 'found',
    article: {
      id: row.id,
      slug: row.slug,
      locale: row.locale,
      fallback: row.locale !== scope.locale,
      visibility: row.visibility,
      title: row.title,
      description: row.description,
      bodyHtml: row.body_html,
      publishedAt: iso(row.published_at),
      locales: localesOf(row.locales),
      section: { id: row.section_id, slug: row.section_slug, name: name(row.section_names) },
      category: { id: row.category_id, slug: row.category_slug, name: name(row.category_names) },
    },
  };
};

/**
 * One entry per article per language a *visitor* may read, with the other
 * languages it can be read in for `hreflang`. Always the public audience: a
 * sitemap is published to search engines. Empty for an internal-only help
 * center, because the filter is false for every row of it.
 */
export const readSitemap = async (tx: DbTransaction): Promise<HcSitemapEntry[]> => {
  const rows = await tx.execute<{
    slug: string;
    locale: HcLocale;
    published_at: Date | string;
    alternates: readonly string[] | string | null;
  }>(sql`
    with ${readableVersions('public')}
    select a.slug, r.locale, r.published_at,
      (select array_agg(r2.locale) from readable r2 where r2.article_id = r.article_id) as alternates
    from readable r
    join hc_articles a on a.id = r.article_id
    order by a.slug, r.locale`);

  return rows.map((row) => ({
    slug: row.slug,
    locale: row.locale,
    lastModified: iso(row.published_at),
    alternates: localesOf(row.alternates),
  }));
};

/** The most rows one "changed since" call answers; the caller pages on `changedAt`. */
export const CHANGED_SINCE_LIMIT = 500;

/**
 * Every version whose published state moved after `since`, oldest first, and
 * whether the audience may read it now — the input search (M5-05) and, from
 * M7, knowledge chunks use to catch up. The slug is withheld from a row the
 * audience may not read.
 */
export const readChangedSince = async (
  tx: DbTransaction,
  audience: HcAudience,
  since: Date,
  limit = CHANGED_SINCE_LIMIT,
): Promise<HcChangedVersion[]> => {
  const rows = await tx.execute<{
    article_id: string;
    locale: HcLocale;
    changed_at: Date | string;
    slug: string;
    visible: boolean;
  }>(sql`
    select hc_article_versions.article_id, hc_article_versions.locale::text as locale,
      hc_article_versions.changed_at, a.slug, ${readableBy(audience)} as visible
    from hc_article_versions
    join hc_articles a on a.id = hc_article_versions.article_id
    where hc_article_versions.changed_at > ${since.toISOString()}::timestamptz
    order by hc_article_versions.changed_at, hc_article_versions.id
    limit ${Math.min(Math.max(limit, 1), CHANGED_SINCE_LIMIT)}`);

  return rows.map((row) => ({
    articleId: row.article_id,
    locale: row.locale,
    visible: row.visible,
    slug: row.visible ? row.slug : null,
    changedAt: iso(row.changed_at),
  }));
};
