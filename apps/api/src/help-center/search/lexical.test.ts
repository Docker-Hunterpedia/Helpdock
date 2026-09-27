import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { hitDetailsSql, lexicalCandidatesSql } from './lexical.js';
import { searchTerms } from './query-terms.js';

const dialect = new PgDialect();
const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql.replace(/\s+/g, ' '), params: query.params };
};

const terms = searchTerms('refund timel');
if (terms === null) {
  throw new Error('the fixture query has words');
}
const scope = {
  brandId: '0192c3f0-0000-7000-8000-000000000001',
  audience: 'public' as const,
  locale: 'ar' as const,
  defaultLocale: 'en' as const,
};

/**
 * DOMAIN-RULES §5: "For `visitor`, the SQL for both vector and full-text
 * search filters `visibility = 'public' AND status = 'published'` **before**
 * ranking. There is no post-filter path; a test asserts the filter is present
 * in the generated SQL." This is that test for help center search.
 */
describe('the lexical search query', () => {
  it('opens with the visibility filter and ranks only index rows joined to a readable version', () => {
    const { sql } = render(lexicalCandidatesSql(scope, terms));
    const filter = sql.indexOf("hc_article_versions.visibility = 'public'");
    const join = sql.indexOf('join readable r on r.article_id = d.article_id');
    const rank = sql.indexOf('ts_rank_cd');

    expect(sql).toMatch(/^ ?with readable as \( select .* from hc_article_versions where/);
    expect(sql).toContain("hc_article_versions.status = 'published'");
    expect(filter).toBeGreaterThan(-1);
    expect(join).toBeGreaterThan(filter);
    expect(rank).toBeGreaterThan(join);
  });

  it('lets staff match internal versions, still published only', () => {
    const { sql } = render(lexicalCandidatesSql({ ...scope, audience: 'internal' }, terms));

    expect(sql).toContain("hc_article_versions.status = 'published'");
    expect(sql).not.toContain("visibility = 'public'");
  });

  it('reads the page’s details through the same filter and cuts plain-text snippets', () => {
    const { sql } = render(hitDetailsSql(scope, terms, ['0192c3f0-0000-7000-8000-00000000000a']));

    expect(sql).toMatch(/^ ?with readable as \(/);
    expect(sql).toContain('ts_headline(');
    expect(sql).toContain('join readable r on r.article_id = t.article_id');
  });
});
