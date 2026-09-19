import { customType } from 'drizzle-orm/pg-core';

/**
 * `tsvector`, which Drizzle has no column type for. Declared once here because
 * `tickets.search` needs it now and `hc_article_versions.search` needs the same
 * thing in M5 (ARCHITECTURE §5).
 *
 * The driver hands the column back as text, and nothing reads it: it exists to
 * be matched against a `tsquery` in SQL and is never selected into a DTO. The
 * data type is `string` so that a column list stays typed, not so that anybody
 * parses one.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});
