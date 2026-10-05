import { type Db, type DbTransaction, hcSearchLog, systemContext, withTenant } from '@helpdock/db';
import { HC_SEARCH_LIMIT_MAX } from '@helpdock/schemas';
import type { QueryEmbedder } from '../../knowledge/retrieval/retrieve.js';
import { defaultLocaleOf, nameIn } from '../content-reader.js';
import type { HelpCenterSearch, SearchHit, SearchQuery, SearchResult } from '../ports.js';
import { type HitRow, hitDetailsSql, lexicalSource } from './lexical.js';
import { normalizeQuery, searchTerms } from './query-terms.js';
import { type Candidate, type CandidateSource, mergeRankings } from './ranking.js';
import { semanticSource } from './semantic.js';

/**
 * `HelpCenterSearch` (M5-05): the help center's search box, the widget's
 * search and its suggestions.
 *
 * Every source filters by the audience in SQL before it ranks (`lexical.ts`);
 * the sources' lists are merged (`ranking.ts`) — the lexical one and, once
 * the install has an embedding model, M7-04's semantic one (`semantic.ts`); the page asked for is read back with its snippets; and the query
 * is written to `hc_search_log` with how many articles it found, zero
 * included, in the same transaction.
 *
 * The transaction is the system principal's, scoped to the one brand, for the
 * reason `HelpCenterContentService` gives: a visitor has no principal, and the
 * audience is what narrows the rows.
 */

const SEARCH_PRINCIPAL = 'help_center.search';

export class HelpCenterSearchService implements HelpCenterSearch {
  readonly #db: Db;
  readonly #sources: readonly CandidateSource[];

  readonly #embedQuery: QueryEmbedder | undefined;

  /**
   * `embedQuery` turns on the semantic source (M7-04); without it, or while it
   * answers null, search is the lexical source alone.
   */
  constructor(
    db: Db,
    {
      sources = [lexicalSource, semanticSource],
      embedQuery,
    }: { readonly sources?: readonly CandidateSource[]; readonly embedQuery?: QueryEmbedder } = {},
  ) {
    this.#db = db;
    this.#sources = sources;
    this.#embedQuery = embedQuery;
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const q = normalizeQuery(query.q);
    const terms = searchTerms(q);
    if (terms === null) {
      return { hits: [], total: 0, searchId: null };
    }
    const limit = Math.min(Math.max(query.limit, 1), HC_SEARCH_LIMIT_MAX);
    const offset = Math.max(query.offset, 0);
    // Before the transaction: a provider call takes a while and holds nothing.
    const queryVector =
      this.#embedQuery === undefined ? null : await this.#embedQuery(query.brandId, q);

    return withTenant(this.#db, systemContext(query.brandId, SEARCH_PRINCIPAL), async (tx) => {
      const scope = {
        brandId: query.brandId,
        audience: query.audience,
        locale: query.locale,
        defaultLocale: await defaultLocaleOf(tx, query.brandId),
        ...(queryVector === null ? {} : { queryVector }),
      };
      const lists: (readonly Candidate[])[] = [];
      for (const source of this.#sources) {
        lists.push(await source.candidates(tx, scope, terms));
      }
      const ranked = mergeRankings(lists);
      const page = ranked.slice(offset, offset + limit);
      const rows =
        page.length === 0
          ? []
          : await tx.execute<HitRow>(
              hitDetailsSql(
                scope,
                terms,
                page.map((candidate) => candidate.articleId),
              ),
            );
      const searchId =
        query.log === false || offset > 0
          ? null
          : await logSearch(tx, { ...query, q, hits: ranked.length });

      return {
        hits: inRankOrder(page, rows, scope.locale, scope.defaultLocale),
        total: ranked.length,
        searchId,
      };
    });
  }
}

const logSearch = async (
  tx: DbTransaction,
  entry: Pick<SearchQuery, 'brandId' | 'locale' | 'source'> & { q: string; hits: number },
): Promise<string> => {
  const [row] = await tx
    .insert(hcSearchLog)
    .values({
      brandId: entry.brandId,
      query: entry.q,
      locale: entry.locale,
      source: entry.source,
      hits: entry.hits,
    })
    .returning({ id: hcSearchLog.id });
  /* c8 ignore next 3 -- an insert returns its row. */
  if (row === undefined) {
    throw new Error('The search log insert returned no row');
  }
  return row.id;
};

/** The detail rows in the ranking's order; a candidate whose row vanished meanwhile is dropped. */
export const inRankOrder = (
  page: readonly Candidate[],
  rows: readonly HitRow[],
  locale: SearchQuery['locale'],
  defaultLocale: SearchQuery['locale'],
): SearchHit[] => {
  const byId = new Map(rows.map((row) => [row.article_id, row]));

  return page.flatMap((candidate) => {
    const row = byId.get(candidate.articleId);
    return row === undefined
      ? []
      : [
          {
            articleId: row.article_id,
            slug: row.slug,
            locale: row.locale,
            title: row.title,
            snippet: row.snippet.trim(),
            sectionTitle: nameIn(row.section_names, locale, defaultLocale),
          },
        ];
  });
};
