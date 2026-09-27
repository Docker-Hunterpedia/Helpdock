import type { DbTransaction } from '@helpdock/db';
import type {
  HcLocale,
  WidgetArticle,
  WidgetArticleQuery,
  WidgetArticleSearch,
  WidgetArticleSearchQuery,
} from '@helpdock/schemas';
import { sql } from 'drizzle-orm';
import { defaultLocaleOf, nameIn } from '../help-center/content-reader.js';
import type { HelpCenterFeedback, HelpCenterSearch } from '../help-center/ports.js';
import { readableVersions } from '../help-center/visibility.js';
import { articleUrl, readingMinutes, summaryOf } from './article-view.js';
import { helpCenterUrlOf } from './widget-config.service.js';
import { WidgetFailure } from './widget-failure.js';
import type { WidgetGate, WidgetRequestFacts } from './widget-gate.js';

/**
 * The widget's help center (M5-10): search, one article, and the popular list
 * in the config — the "help center" mode and the "chat + articles" strip.
 *
 * **Visitors read the public audience only**, always: nothing here takes an
 * audience from the request. The gate runs first (origin, visitor credential,
 * throttle), and the reads then go through the help center's own services,
 * which filter in SQL before they rank (DOMAIN-RULES §5).
 *
 * Opening an article counts one view for this visitor, deduplicated per day
 * by the feedback service, and marks the search it was opened from.
 */

type ArticleRow = {
  readonly article_id: string;
  readonly locale: HcLocale;
  readonly title: string;
  readonly description: string;
  readonly body_html: string;
  readonly body_text: string | null;
  readonly published_at: Date | string;
  readonly slug: string;
  readonly section_names: Readonly<Record<string, string | undefined>>;
};

/** One published public article by id, in `locale` or the brand's default, or undefined. */
export const readPublicArticle = async (
  tx: DbTransaction,
  brandId: string,
  articleId: string,
  locale: HcLocale,
): Promise<(Omit<WidgetArticle, 'url'> & { readonly slug: string }) | undefined> => {
  const defaultLocale = await defaultLocaleOf(tx, brandId);
  const [row] = await tx.execute<ArticleRow>(sql`
    with ${readableVersions('public')}
    select r.article_id, r.locale, r.title, r.description, r.body_html, r.published_at,
      v.published_body_text as body_text, a.slug, s.names as section_names
    from readable r
    join hc_article_versions v on v.article_id = r.article_id and v.locale::text = r.locale
    join hc_articles a on a.id = r.article_id
    join hc_sections s on s.id = a.section_id
    where r.article_id = ${articleId}::uuid and r.locale in (${locale}, ${defaultLocale})
    order by (r.locale = ${locale}) desc
    limit 1`);
  if (row === undefined) {
    return undefined;
  }
  const section = nameIn(row.section_names, locale, defaultLocale);

  return {
    id: row.article_id,
    slug: row.slug,
    locale: row.locale,
    title: row.title,
    excerpt: row.description,
    section: section === '' ? null : section,
    updatedAt: new Date(row.published_at).toISOString(),
    readingMinutes: readingMinutes(row.body_text ?? ''),
    bodyHtml: row.body_html,
  };
};

export interface WidgetArticlesDependencies {
  readonly gate: WidgetGate;
  readonly search: HelpCenterSearch;
  readonly feedback: HelpCenterFeedback;
}

export class WidgetArticlesService {
  readonly #deps: WidgetArticlesDependencies;

  constructor(deps: WidgetArticlesDependencies) {
    this.#deps = deps;
  }

  /** `GET …/articles?q=`. A suggestion (`purpose: 'suggest'`) is searched but not logged. */
  async search(
    brandId: string,
    facts: WidgetRequestFacts,
    query: WidgetArticleSearchQuery,
  ): Promise<WidgetArticleSearch> {
    const helpCenterUrl = await this.#deps.gate.visitor(
      brandId,
      facts,
      { write: false },
      ({ tx }) => helpCenterUrlOf(tx),
    );
    const result = await this.#deps.search.search({
      brandId,
      audience: 'public',
      locale: query.locale,
      q: query.q,
      limit: query.limit,
      offset: 0,
      source: 'widget',
      log: query.purpose === 'search',
    });

    return {
      articles: result.hits.map((hit) => summaryOf(hit, helpCenterUrl)),
      searchId: result.searchId ?? null,
    };
  }

  /** `GET …/articles/:articleId`: `not_found` for anything a visitor may not read. */
  async article(
    brandId: string,
    facts: WidgetRequestFacts,
    articleId: string,
    query: WidgetArticleQuery,
  ): Promise<WidgetArticle> {
    const { article, visitorId } = await this.#deps.gate.visitor(
      brandId,
      facts,
      { write: false },
      async ({ tx, visitor }) => {
        const found = await readPublicArticle(tx, brandId, articleId, query.locale);
        if (found === undefined) {
          throw new WidgetFailure('not_found', 'No such article');
        }
        const { slug, ...rest } = found;
        return {
          article: { ...rest, url: articleUrl(await helpCenterUrlOf(tx), found.locale, slug) },
          visitorId: visitor.id,
        };
      },
    );
    await this.#deps.feedback.recordView({
      brandId,
      articleId,
      locale: article.locale,
      visitorKey: `widget:${visitorId}`,
      ...(query.searchId === undefined ? {} : { searchId: query.searchId }),
    });

    return article;
  }
}
