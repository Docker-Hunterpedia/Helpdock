import { type DbTransaction, importLog } from '@helpdock/db';
import type { ImportEntity } from '@helpdock/schemas';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { importRecordIssueSchema } from '../preflight/record-page.js';
import type { ImportRunRef } from './claims.js';

const sourceWarningCodes = [
  'import.record-unavailable',
  'import.mapping.unknown-value',
  'import.field.unsupported-semantics',
  'import.csat.timestamp-inferred',
  'import.csat.scale-normalized',
  'import.csat.rating-unmapped',
  'import.knowledge.readership-restricted',
  'import.knowledge.locale-unsupported',
  'import.message.author-unavailable',
  'import.message.identity-unavailable',
  'import.message.unsent-thread',
  'import.zoho.full-content-format-inferred',
  'import.zoho.article-files-envelope-inferred',
  'import.zoho.description-fallback',
  'import.profile.inactive-source',
] as const;
const rowsSchema = z
  .array(importRecordIssueSchema.extend({ total: z.number().int().nonnegative() }))
  .max(100);

/** Extraction warnings must participate in the dry-run receipt, not only an optional log tab. */
export async function importVendorSourceWarnings(
  tx: DbTransaction,
  scope: ImportRunRef & { entities: ImportEntity[] },
) {
  if (!scope.entities.length) return { sourceWarningCount: 0, sourceWarnings: [] };
  const distinct = tx
    .selectDistinct({
      entity: importLog.entity,
      externalId: sql<string>`coalesce(${importLog.externalId}, ${scope.runId})`.as('external_id'),
      code: importLog.message,
    })
    .from(importLog)
    .where(
      and(
        eq(importLog.brandId, scope.brandId),
        eq(importLog.runId, scope.runId),
        eq(importLog.level, 'warning'),
        isNotNull(importLog.entity),
        inArray(importLog.entity, scope.entities),
        inArray(importLog.message, [...sourceWarningCodes]),
      ),
    )
    .as('source_warnings');
  const rows = rowsSchema.parse(
    await tx
      .select({
        entity: distinct.entity,
        externalId: distinct.externalId,
        code: distinct.code,
        total: sql<number>`count(*) over ()::int`,
      })
      .from(distinct)
      .orderBy(distinct.entity, distinct.externalId, distinct.code)
      .limit(100),
  );
  return {
    sourceWarningCount: rows[0]?.total ?? 0,
    sourceWarnings: rows.map(({ total: _total, ...issue }) => issue),
  };
}
