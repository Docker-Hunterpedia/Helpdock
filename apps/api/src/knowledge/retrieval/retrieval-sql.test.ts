import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { semanticCandidatesSql } from '../../help-center/search/semantic.js';
import { chunkDetailsSql, lexicalChunksSql, vectorChunksSql } from './retrieve.js';
import { visibleChunks } from './visibility.js';

const dialect = new PgDialect();
const text = (fragment: Parameters<PgDialect['sqlToQuery']>[0]): string =>
  dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ');

const BRAND = '0199b0a4-0000-7000-8000-000000000001';
const vector = { model: 'bag', literal: '[0.1,0.2]' };
const visitorFilter = text(visibleChunks('visitor'));

/**
 * DOMAIN-RULES §5: "For `visitor`, the SQL for both vector and full-text
 * search filters `visibility = 'public' AND status = 'published'` before
 * ranking. There is no post-filter path; a test asserts the filter is present
 * in the generated SQL." This is that test for M7-04's retrieval.
 */
describe('the retrieval visibility filter', () => {
  it('lets a visitor use only public sources and live, public, published articles', () => {
    expect(visitorFilter).toContain("c.visibility = 'public' and s.visibility = 'public'");
    expect(visitorFilter).toContain("hc_article_versions.status = 'published'");
    expect(visitorFilter).toContain("hc_article_versions.visibility = 'public'");
    expect(visitorFilter).toContain("hc_settings.access = 'internal_only'");
    expect(visitorFilter).toContain("hc_article_versions.locale::text = c.meta->>'articleLocale'");
  });

  it('lets staff use internal sources, but only published articles', () => {
    const staff = text(visibleChunks('staff'));

    expect(staff).toContain('c.article_id is null or exists');
    expect(staff).toContain("hc_article_versions.status = 'published'");
    expect(staff).not.toContain("c.visibility = 'public'");
  });

  it.each([
    ['vector', text(vectorChunksSql(BRAND, 'visitor', vector)), 'order by c.embedding <=>'],
    ['full text', text(lexicalChunksSql(BRAND, 'visitor', 'refund')), 'order by ts_rank_cd'],
  ])('puts the filter in the %s ranker’s WHERE, before it orders', (_, sql, orderBy) => {
    const where = sql.indexOf(visitorFilter);

    expect(where).toBeGreaterThan(sql.indexOf(' where c.brand_id = $1'));
    expect(where).toBeLessThan(sql.indexOf(orderBy));
  });

  it('ranks vectors of the active model only', () => {
    expect(text(vectorChunksSql(BRAND, 'staff', vector))).toContain(
      'c.embedding_model = $2 and c.embedding is not null',
    );
  });

  it('checks the audience again when it reads the chosen chunks back', () => {
    const sql = text(chunkDetailsSql(BRAND, 'visitor', ['0199b0a4-0000-7000-8000-000000000002']));

    expect(sql.split(visitorFilter).length).toBe(3);
  });

  it('joins the readable versions before the semantic help center source ranks', () => {
    const sql = text(
      semanticCandidatesSql(
        { brandId: BRAND, audience: 'public', locale: 'en', defaultLocale: 'en' },
        vector.literal,
        vector.model,
      ),
    );

    expect(sql).toMatch(/^ with readable as \(.*hc_article_versions\.visibility = 'public'/);
    expect(sql).toContain('join readable r on r.article_id = c.article_id');
    expect(sql.indexOf('join readable')).toBeLessThan(sql.indexOf('order by distance'));
  });
});
