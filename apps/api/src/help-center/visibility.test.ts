import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { goneFor, readableBy, readableVersions } from './visibility.js';

const dialect = new PgDialect();
const text = (fragment: Parameters<PgDialect['sqlToQuery']>[0]): string =>
  dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ');

/**
 * DOMAIN-RULES §5: "a test asserts the filter is present in the generated
 * SQL". The read service builds every query on `readableVersions`, so this is
 * that assertion.
 */
describe('the visibility filter', () => {
  it('lets a visitor read only published, public versions of a help center that is not internal-only', () => {
    const sql = text(readableBy('public'));

    expect(sql).toContain("hc_article_versions.status = 'published'");
    expect(sql).toContain("hc_article_versions.visibility = 'public'");
    expect(sql).toContain('not exists ( select 1 from hc_settings');
    expect(sql).toContain("hc_settings.access = 'internal_only'");
  });

  it('lets staff read internal versions, but still only published ones', () => {
    const sql = text(readableBy('internal'));

    expect(sql).toContain("hc_article_versions.status = 'published'");
    expect(sql).not.toContain('visibility');
  });

  it('puts the filter in the WHERE of the CTE every read starts from', () => {
    const sql = text(readableVersions('public'));

    expect(sql).toMatch(
      /^readable as \( select .* from hc_article_versions where \(hc_article_versions\.status = 'published' and hc_article_versions\.visibility = 'public'/,
    );
  });

  it('calls an archived version gone only for the audience that could have read it', () => {
    expect(text(goneFor('public'))).toContain("hc_article_versions.visibility = 'public'");
    expect(text(goneFor('public'))).toContain("hc_article_versions.status = 'archived'");
    expect(text(goneFor('internal'))).not.toContain('visibility');
  });
});
