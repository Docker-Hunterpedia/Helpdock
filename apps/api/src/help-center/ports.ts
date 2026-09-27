import type { HcAudience, HcLocale } from '@helpdock/schemas';

/**
 * The seams between the help center pages (M5-03, M5-04, M5-06) and the
 * services they render from (M5-05 search, M5-08 feedback and views). The
 * pages depend on these interfaces only; `HelpCenterModule` binds them to the
 * implementations. Both sides take the `audience` the caller is allowed
 * (AGENTS.md, "Retrieval always takes an `audience`").
 */

export interface SearchQuery {
  readonly brandId: string;
  readonly audience: HcAudience;
  readonly locale: HcLocale;
  readonly q: string;
  readonly limit: number;
  readonly offset: number;
  /** Where the search came from, for the search log. */
  readonly source: 'help_center' | 'widget';
  /**
   * False for a search that is not a visitor's question — the widget's
   * suggestions while a chat message is typed. Default true; only the first
   * page (`offset` 0) of a search is logged either way.
   */
  readonly log?: boolean;
}

export interface SearchHit {
  readonly articleId: string;
  readonly slug: string;
  /** The locale the hit was found in; differs from the query's on a fallback. */
  readonly locale: HcLocale;
  readonly title: string;
  /** Plain text around the match, no markup. The renderer escapes and highlights. */
  readonly snippet: string;
  readonly sectionTitle: string;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly total: number;
  /**
   * The search log row, when this call wrote one. A page that passes it back
   * to `recordView` when the visitor opens a hit feeds the Insights tab's
   * "Opened a result".
   */
  readonly searchId?: string | null;
}

export interface HelpCenterSearch {
  /** Readable, published articles only, ranked; logs the query (zero results included). */
  search(query: SearchQuery): Promise<SearchResult>;
}

export const HELP_CENTER_SEARCH = Symbol('HelpCenterSearch');

export interface ArticleRef {
  readonly brandId: string;
  readonly articleId: string;
  readonly locale: HcLocale;
}

export interface HelpCenterFeedback {
  /** Counts one view; deduplicated per visitor per article per day by the implementation. */
  recordView(
    ref: ArticleRef & {
      readonly visitorKey: string;
      /** `SearchResult.searchId` of the search the visitor opened this from. */
      readonly searchId?: string;
    },
  ): Promise<void>;
  /** "Was this helpful?" One vote per visitor per article version; a second replaces the first. */
  recordVote(
    ref: ArticleRef & {
      readonly visitorKey: string;
      readonly helpful: boolean;
      /** The optional "What was missing?" after a "No" (`HelpCenter/Article-AR`, panel 2). */
      readonly comment?: string;
    },
  ): Promise<void>;
  /** Most viewed readable articles over the last 30 days, for the home page and the widget. */
  popular(query: {
    readonly brandId: string;
    readonly audience: HcAudience;
    readonly locale: HcLocale;
    readonly limit: number;
  }): Promise<readonly PopularArticle[]>;
}

/** `popular`'s answer: a hit without a snippet, with the article's search description. */
export type PopularArticle = Omit<SearchHit, 'snippet'> & { readonly description?: string };

export const HELP_CENTER_FEEDBACK = Symbol('HelpCenterFeedback');
