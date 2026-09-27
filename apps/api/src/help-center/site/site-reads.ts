import type { DbTransaction } from '@helpdock/db';
import type { HcAudience, HcLocale } from '@helpdock/schemas';
import { sql } from 'drizzle-orm';
import { nameIn } from '../content-reader.js';
import { goneFor } from '../visibility.js';

/**
 * The two reads the pages need that `HelpCenterContentService` does not
 * answer, because nothing but a page needs them (M5-03, `HelpCenter/States-EN`):
 *
 * - what an **archived** article was called and where it lived, for the 410
 *   page's "was retired on …" and "More in …". It goes through the same
 *   `goneFor(audience)` filter the content service answers `gone` with, so a
 *   visitor learns nothing about an archived *internal* article (still a 404);
 * - an article's **working copy**, for the editor's Preview. Staff only: the
 *   caller has already established a staff session of this brand.
 */

type Names = Readonly<Record<string, string | undefined>>;

export interface GoneArticle {
  readonly title: string;
  readonly locale: HcLocale;
  readonly retiredAt: Date;
  readonly sectionId: string;
  readonly sectionName: string;
}

export const readGone = async (
  tx: DbTransaction,
  scope: { audience: HcAudience; locale: HcLocale; defaultLocale: HcLocale },
  slug: string,
): Promise<GoneArticle | null> => {
  const [row] = await tx.execute<{
    title: string;
    locale: HcLocale;
    changed_at: Date | string;
    section_id: string;
    section_names: Names;
  }>(sql`
    select coalesce(hc_article_versions.published_title, hc_article_versions.title) as title,
      hc_article_versions.locale::text as locale, hc_article_versions.changed_at,
      s.id as section_id, s.names as section_names
    from hc_article_versions
    join hc_articles a on a.id = hc_article_versions.article_id
    join hc_sections s on s.id = a.section_id
    where a.slug = ${slug} and ${goneFor(scope.audience)}
      and hc_article_versions.locale in (${scope.locale}, ${scope.defaultLocale})
    order by (hc_article_versions.locale = ${scope.locale}) desc
    limit 1`);
  if (row === undefined) {
    return null;
  }
  return {
    title: row.title,
    locale: row.locale,
    retiredAt: new Date(row.changed_at),
    sectionId: row.section_id,
    sectionName: nameIn(row.section_names, scope.locale, scope.defaultLocale),
  };
};

export type PreviewState = 'draft' | 'scheduled' | 'changes' | 'archived' | 'published';

export interface PreviewArticle {
  readonly id: string;
  readonly slug: string;
  readonly locale: HcLocale;
  readonly state: PreviewState;
  readonly visibility: 'public' | 'internal';
  readonly title: string;
  readonly description: string;
  readonly bodyHtml: string;
  readonly scheduledAt: Date | null;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date;
  readonly section: { readonly id: string; readonly slug: string; readonly name: string };
  readonly category: { readonly id: string; readonly slug: string; readonly name: string };
}

type PreviewRow = {
  id: string;
  slug: string;
  locale: HcLocale;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  visibility: 'public' | 'internal';
  title: string;
  description: string;
  body_html: string;
  published_title: string | null;
  published_description: string | null;
  published_body_html: string | null;
  scheduled_at: Date | string | null;
  published_at: Date | string | null;
  updated_at: Date | string;
  section_id: string;
  section_slug: string;
  section_names: Names;
  category_id: string;
  category_slug: string;
  category_names: Names;
};

const stateOf = (row: PreviewRow): PreviewState => {
  if (row.status !== 'published') {
    return row.status;
  }
  const changed =
    row.title !== row.published_title ||
    row.description !== row.published_description ||
    row.body_html !== row.published_body_html;
  return changed ? 'changes' : 'published';
};

const dateOrNull = (value: Date | string | null): Date | null =>
  value === null ? null : new Date(value);

/** One language of an article as the editor last saved it, whatever its status. */
export const readPreview = async (
  tx: DbTransaction,
  scope: { locale: HcLocale; defaultLocale: HcLocale },
  slug: string,
): Promise<PreviewArticle | null> => {
  const [row] = await tx.execute<PreviewRow>(sql`
    select a.id, a.slug, v.locale::text as locale, v.status::text as status,
      v.visibility::text as visibility, v.title, v.description, v.body_html,
      v.published_title, v.published_description, v.published_body_html,
      v.scheduled_at, v.published_at, v.updated_at,
      s.id as section_id, s.slug as section_slug, s.names as section_names,
      c.id as category_id, c.slug as category_slug, c.names as category_names
    from hc_article_versions v
    join hc_articles a on a.id = v.article_id
    join hc_sections s on s.id = a.section_id
    join hc_categories c on c.id = s.category_id
    where a.slug = ${slug} and v.locale = ${scope.locale}
    limit 1`);
  if (row === undefined) {
    return null;
  }
  const name = (names: Names) => nameIn(names, scope.locale, scope.defaultLocale);
  return {
    id: row.id,
    slug: row.slug,
    locale: row.locale,
    state: stateOf(row),
    visibility: row.visibility,
    title: row.title,
    description: row.description,
    bodyHtml: row.body_html,
    scheduledAt: dateOrNull(row.scheduled_at),
    publishedAt: dateOrNull(row.published_at),
    updatedAt: new Date(row.updated_at),
    section: { id: row.section_id, slug: row.section_slug, name: name(row.section_names) },
    category: { id: row.category_id, slug: row.category_slug, name: name(row.category_names) },
  };
};

/** The article's slug, for the editor's Preview, which knows the article by id. */
export const readArticleSlug = async (
  tx: DbTransaction,
  articleId: string,
): Promise<string | null> => {
  const [row] = await tx.execute<{ slug: string }>(
    sql`select slug from hc_articles where id = ${articleId} limit 1`,
  );
  return row?.slug ?? null;
};
