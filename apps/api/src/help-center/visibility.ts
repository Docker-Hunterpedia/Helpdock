import type { HcAudience } from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';

/**
 * Who may read which version of an article (DOMAIN-RULES §5, M5-09), as SQL.
 *
 * Every read the help center, its sitemap, its search and — from M7 — the
 * visitor-facing AI make starts from {@link readableVersions}: a CTE over
 * `hc_article_versions` whose `WHERE` is this filter, so ranking, fallback and
 * joins only ever see rows the audience may read. There is no post-filter
 * path, and `visibility.test.ts` asserts the filter is in the generated SQL.
 *
 * For the **public** audience a version must be published, public, and in a
 * help center that is not internal-only — the brand setting "forces all its
 * articles to internal" by making this condition false for every row, rather
 * than by rewriting them, so switching the mode back restores each article's
 * own choice.
 *
 * For the **internal** audience (signed-in staff) a version must be
 * published; staff may read internal articles.
 *
 * The expressions name `hc_article_versions` unaliased, so a query using them
 * must select from that table under its own name.
 */

const internalOnlyHelpCenter = sql`exists (
  select 1 from hc_settings
  where hc_settings.brand_id = hc_article_versions.brand_id
    and hc_settings.access = 'internal_only')`;

const visibleTo = (audience: HcAudience): SQL =>
  audience === 'public'
    ? sql`hc_article_versions.visibility = 'public' and not ${internalOnlyHelpCenter}`
    : sql`true`;

/** A version the audience may read now. */
export const readableBy = (audience: HcAudience): SQL =>
  sql`(hc_article_versions.status = 'published' and ${visibleTo(audience)})`;

/**
 * A version the audience could read if it had not been archived. Its page
 * answers 410 rather than 404; an internal article that was archived is still
 * a 404 to a visitor, because "it existed" is itself something they may not
 * learn.
 */
export const goneFor = (audience: HcAudience): SQL =>
  sql`(hc_article_versions.status = 'archived' and ${visibleTo(audience)})`;

/**
 * `readable`: the published text of every version the audience may read. The
 * first clause of every read-side query, so nothing after it can see a row the
 * filter refused.
 */
export const readableVersions = (audience: HcAudience): SQL => sql`readable as (
  select
    hc_article_versions.article_id,
    hc_article_versions.locale::text as locale,
    hc_article_versions.visibility::text as visibility,
    coalesce(hc_article_versions.published_title, hc_article_versions.title) as title,
    coalesce(hc_article_versions.published_description, '') as description,
    coalesce(hc_article_versions.published_body_html, '') as body_html,
    coalesce(hc_article_versions.published_at, hc_article_versions.changed_at) as published_at
  from hc_article_versions
  where ${readableBy(audience)}
)`;
