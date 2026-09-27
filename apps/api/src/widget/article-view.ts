import type { HcLocale, WidgetArticleSummary } from '@helpdock/schemas';
import type { PopularArticle, SearchHit } from '../help-center/ports.js';

/**
 * How a help center article looks on the widget's wire (M5-10): the help
 * center's hits and popular list, as `widgetArticleSummarySchema`. Pure.
 */

/** How many popular articles the config lists. */
export const WIDGET_POPULAR_ARTICLES = 5;

const WORDS_PER_MINUTE = 200;

/** `/<locale>/articles/<slug>` on the brand's help center host (M5-01), or null without one. */
export const articleUrl = (
  helpCenterUrl: string | null,
  locale: HcLocale,
  slug: string,
): string | null =>
  helpCenterUrl === null ? null : `${helpCenterUrl}/${locale}/articles/${encodeURIComponent(slug)}`;

export const readingMinutes = (text: string): number =>
  Math.max(1, Math.ceil((text.match(/\S+/g)?.length ?? 0) / WORDS_PER_MINUTE));

/** A search hit shows the words around the match; a popular article its description. */
export const summaryOf = (
  hit: Omit<SearchHit, 'snippet'> & { readonly snippet?: string; readonly description?: string },
  helpCenterUrl: string | null,
): WidgetArticleSummary => ({
  id: hit.articleId,
  title: hit.title,
  excerpt: hit.snippet ?? hit.description ?? '',
  section: hit.sectionTitle === '' ? null : hit.sectionTitle,
  url: articleUrl(helpCenterUrl, hit.locale, hit.slug),
});

export const popularSummaries = (
  articles: readonly PopularArticle[],
  helpCenterUrl: string | null,
): WidgetArticleSummary[] => articles.map((article) => summaryOf(article, helpCenterUrl));
