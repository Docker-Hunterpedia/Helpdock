import type { HcLocale } from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';
import { readableVersions } from '../visibility.js';
import type { SearchTerms } from './query-terms.js';
import {
  CANDIDATE_LIMIT,
  type Candidate,
  type CandidateScope,
  type CandidateSource,
} from './ranking.js';

/**
 * The lexical candidates (M5-05): Postgres full text in the language's own
 * configuration, weighted title over description over body, with `pg_trgm`
 * on the title for typos.
 *
 * **Visibility first.** The query starts `with readable as (…)` —
 * `readableVersions(audience)` — and an index row only takes part by joining
 * the live version that CTE let through. Nothing is ranked that the audience
 * may not read, and a row the subscriber has not caught up with yet cannot
 * outlive the version's own status or visibility (DOMAIN-RULES §5).
 * `search.test.ts` asserts the join is in the SQL.
 *
 * **One version per article**: the reader's language when the index has it,
 * else the brand's default — the fallback `content-reader.ts` applies to pages.
 *
 * **Score**, highest first:
 *
 *     rank(every word) + 0.5 × rank(any word) + 0.6 × word_similarity(query, title)
 *
 * `ts_rank_cd` with normalisation 32 (`rank / (rank + 1)`), so each term stays
 * below 1 and the trigram similarity can lift a title the visitor misspelled
 * above a body that merely mentions one of the words. A version takes part
 * when any word matches or the title is at least {@link FUZZY_THRESHOLD}
 * similar to the query.
 */

/** `word_similarity` a title needs to match on trigrams alone: one typo in a short word passes. */
export const FUZZY_THRESHOLD = 0.4;

const configFor = (locale: SQL): SQL =>
  sql`(case when ${locale} = 'ar' then 'arabic' else 'english' end)::regconfig`;

/** The shared opening of the candidate and the detail queries. */
export const matchedDocuments = (scope: CandidateScope, terms: SearchTerms): SQL => sql`
  ${readableVersions(scope.audience)},
  docs as (
    select d.article_id, d.locale::text as locale, d.search, d.title_normalized, d.body_text,
      d.description
    from hc_search_documents d
    join readable r on r.article_id = d.article_id and r.locale = d.locale::text
    where d.locale::text in (${scope.locale}, ${scope.defaultLocale})
  ),
  picked as (
    select distinct on (article_id) *
    from docs
    order by article_id, (locale = ${scope.locale}) desc
  ),
  terms as (
    select p.*,
      to_tsquery(${configFor(sql`p.locale`)}, ${terms.all}) as q_all,
      to_tsquery(${configFor(sql`p.locale`)}, ${terms.any}) as q_any,
      word_similarity(${terms.fuzzy}, p.title_normalized) as fuzzy
    from picked p
  )`;

export const lexicalCandidatesSql = (scope: CandidateScope, terms: SearchTerms): SQL => sql`
  with ${matchedDocuments(scope, terms)}
  select article_id, locale,
    (case when search @@ q_all then ts_rank_cd(search, q_all, 32) else 0 end)
      + 0.5 * (case when search @@ q_any then ts_rank_cd(search, q_any, 32) else 0 end)
      + 0.6 * fuzzy as score
  from terms
  where search @@ q_any or fuzzy >= ${FUZZY_THRESHOLD}
  order by score desc, article_id
  limit ${CANDIDATE_LIMIT}`;

export const lexicalSource: CandidateSource = {
  async candidates(tx, scope, terms): Promise<readonly Candidate[]> {
    const rows = await tx.execute<{ article_id: string; locale: HcLocale }>(
      lexicalCandidatesSql(scope, terms),
    );
    return rows.map((row) => ({ articleId: row.article_id, locale: row.locale }));
  },
};

/** How a snippet is cut: plain text, no markers — the renderer escapes and highlights. */
export const SNIPPET_OPTIONS =
  'StartSel="",StopSel="",MaxWords=30,MinWords=12,MaxFragments=1,FragmentDelimiter=" … "';

export type HitRow = {
  readonly article_id: string;
  readonly locale: HcLocale;
  readonly slug: string;
  readonly title: string;
  readonly snippet: string;
  readonly section_names: Readonly<Record<string, string | undefined>>;
};

/**
 * The page of hits the ranking chose, with what a result shows: the slug, the
 * live published title, the section, and the words around the match. Built on
 * the same visibility-first opening, so a hit is re-checked, not trusted.
 */
export const hitDetailsSql = (
  scope: CandidateScope,
  terms: SearchTerms,
  articleIds: readonly string[],
): SQL => sql`
  with ${matchedDocuments(scope, terms)}
  select t.article_id, t.locale, a.slug, r.title, s.names as section_names,
    ts_headline(${configFor(sql`t.locale`)},
      coalesce(nullif(t.body_text, ''), t.description), t.q_any, ${SNIPPET_OPTIONS}) as snippet
  from terms t
  join readable r on r.article_id = t.article_id and r.locale = t.locale
  join hc_articles a on a.id = t.article_id
  join hc_sections s on s.id = a.section_id
  where t.article_id in (${sql.join(
    articleIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
