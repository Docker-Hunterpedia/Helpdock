import { type DbTransaction, importMappings, importRuns } from '@helpdock/db';
import {
  type ImportMappingValuesQuery,
  importMappingSchema,
  importMappingValuesQuerySchema,
  importMappingValuesSchema,
} from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ImportRunRef } from '../jobs/claims.js';
import { lockImportBrand } from '../jobs/claims.js';
import { ImportMappingEditError } from '../jobs/save-mappings.js';
import { observedImportValues, observedValueMetadata } from './mapping-observations.js';
import { proposeImportMapping } from './mapping-proposals.js';

const rowSchema = z.object({
  value: z.string().max(300),
  hits: z.coerce.number().int().nonnegative().safe(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

/** Keyset pagination includes the empty-string default; no page contains full source records. */
export async function importMappingValues(
  tx: DbTransaction,
  scope: ImportRunRef,
  raw: ImportMappingValuesQuery,
) {
  const query = importMappingValuesQuerySchema.parse(raw);
  await lockImportBrand(tx, scope.brandId);
  const [run] = await tx
    .select({
      status: importRuns.status,
      source: importRuns.source,
      sourceAccountKey: importRuns.sourceAccountKey,
    })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run) throw new ImportMappingEditError('run-unavailable');
  if (!['awaiting_mapping', 'ready'].includes(run.status))
    throw new ImportMappingEditError('run-not-editable');
  const rows = z.array(rowSchema).parse(
    await tx.execute(sql`
    SELECT observed.value, observed.hits::text AS hits, ${observedValueMetadata(scope, query.kind)} AS metadata
    FROM (SELECT value, sum(hits) AS hits FROM (${observedImportValues(scope, query.kind)}) source_values GROUP BY value) observed
    WHERE ${query.after === undefined ? sql`TRUE` : sql`observed.value COLLATE "C" > ${query.after}::text COLLATE "C"`}
    ORDER BY observed.value COLLATE "C" LIMIT ${query.limit + 1}
  `),
  );
  const page = rows.slice(0, query.limit);
  const existing = page.length
    ? await tx
        .select()
        .from(importMappings)
        .where(
          and(
            eq(importMappings.brandId, scope.brandId),
            eq(importMappings.runId, scope.runId),
            eq(importMappings.kind, query.kind),
            inArray(
              importMappings.externalValue,
              page.map((row) => row.value),
            ),
          ),
        )
    : [];
  const confirmed = new Map(
    existing.map((row) => [
      row.externalValue,
      importMappingSchema.parse({
        kind: row.kind,
        externalValue: row.externalValue,
        target: row.target,
      }),
    ]),
  );
  const response = importMappingValuesSchema.parse({
    kind: query.kind,
    values: page.map((row) => {
      const { label: _label, ...field } = row.metadata ?? {};
      return {
        externalValue: row.value,
        label: row.metadata?.name ?? row.metadata?.label ?? row.value,
        occurrences: query.kind === 'field' ? null : row.hits,
        person: query.kind === 'agent' ? row.metadata : null,
        field: query.kind === 'field' ? field : null,
        confirmed: confirmed.get(row.value) ?? null,
        proposed: null,
      };
    }),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.value ?? null) : null,
  });
  for (const row of response.values)
    if (!row.confirmed)
      row.proposed = await proposeImportMapping(
        tx,
        { ...scope, source: run.source, sourceAccountKey: run.sourceAccountKey },
        query.kind,
        row,
      );
  return importMappingValuesSchema.parse(response);
}
