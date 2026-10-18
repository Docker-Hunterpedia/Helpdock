import { type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import {
  type ImportMapping,
  type ImportMappingTargetChoice,
  type ImportMappingTargetsQuery,
  importMappingChoiceId,
  importMappingTargetChoiceSchema,
  importMappingTargetsQuerySchema,
  importMappingTargetsSchema,
  ticketChannelSchema,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ImportRunRef, lockImportBrand } from '../jobs/claims.js';
import { ImportMappingEditError } from '../jobs/save-mappings.js';
import { ImportLoadError } from '../loader/contracts.js';
import { validatedStagedRecord } from './staged-record.js';

function scalarCatalog(kind: 'priority' | 'channel'): SQL {
  const options = kind === 'priority' ? ticketPrioritySchema.options : ticketChannelSchema.options;
  return sql.join(
    options.map(
      (value) => sql`SELECT ${value}::text AS id, ${value}::text AS label,
    NULL::text AS name_ar, NULL::text AS detail, jsonb_build_object(${kind}::text, ${value}::text) AS target`,
    ),
    sql` UNION ALL `,
  );
}

/**
 * This brand's destinations of one kind as (id, label, name_ar, detail, target). Naming a staged
 * source field limits custom fields to the definitions compatible with it.
 */
function destinationCatalog(
  scope: ImportRunRef,
  kind: ImportMapping['kind'],
  compatibleWithField: string | null,
): SQL {
  switch (kind) {
    case 'priority':
    case 'channel':
      return scalarCatalog(kind);
    case 'status':
      return sql`SELECT s.id::text AS id, s.name AS label, s.name_ar, NULL::text AS detail,
      jsonb_build_object('statusId', s.id) AS target FROM ticket_statuses s WHERE s.brand_id = ${scope.brandId}::uuid`;
    case 'tag':
      return sql`SELECT t.id::text AS id, t.name AS label, NULL::text AS name_ar, NULL::text AS detail,
      jsonb_build_object('tagId', t.id) AS target FROM tags t WHERE t.brand_id = ${scope.brandId}::uuid`;
    case 'group':
      return sql`SELECT 'department:' || d.id::text AS id, d.name AS label, d.name_ar, NULL::text AS detail,
      jsonb_build_object('departmentId', d.id, 'teamId', NULL) AS target FROM departments d WHERE d.brand_id = ${scope.brandId}::uuid
      UNION ALL SELECT 'team:' || t.id::text AS id, t.name AS label, NULL::text AS name_ar, d.name AS detail,
      jsonb_build_object('departmentId', d.id, 'teamId', t.id) AS target FROM teams t
      JOIN departments d ON d.id = t.department_id AND d.brand_id = t.brand_id WHERE t.brand_id = ${scope.brandId}::uuid`;
    case 'agent':
      return sql`SELECT u.id::text AS id, u.name AS label, NULL::text AS name_ar, u.email AS detail,
      jsonb_build_object('kind', 'existing', 'userId', u.id) AS target FROM users u
      JOIN user_brand_roles m ON m.user_id = u.id WHERE m.brand_id = ${scope.brandId}::uuid
      AND m.role <> 'viewer' AND u.status IN ('active', 'invited')`;
    case 'field':
      return sql`SELECT f.id::text AS id, f.label, f.label_ar AS name_ar, f.key AS detail,
      jsonb_build_object('kind', 'existing', 'fieldId', f.id) AS target FROM custom_field_defs f
      WHERE f.brand_id = ${scope.brandId}::uuid ${
        compatibleWithField === null
          ? sql``
          : sql`AND EXISTS (SELECT 1 FROM import_records source
        WHERE source.brand_id = f.brand_id AND source.run_id = ${scope.runId}::uuid
          AND source.entity = 'field' AND source.external_id = ${compatibleWithField}
          AND f.target::text = CASE source.payload->>'target' WHEN 'organization' THEN 'account' ELSE source.payload->>'target' END
          AND f.type::text = CASE source.payload->>'type' WHEN 'textarea' THEN 'text' WHEN 'multiselect' THEN 'multi_select' ELSE source.payload->>'type' END)`
      }`;
  }
}

const catalogRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  name_ar: z.string().nullable(),
  detail: z.string().nullable(),
});

export async function requireMappingReview(tx: DbTransaction, scope: ImportRunRef) {
  await lockImportBrand(tx, scope.brandId);
  const [run] = await tx
    .select({ status: importRuns.status })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run) throw new ImportMappingEditError('run-unavailable');
  if (!['awaiting_mapping', 'ready'].includes(run.status))
    throw new ImportMappingEditError('run-not-editable');
}

/** Searches/paginates only this brand's destinations, without returning the full staff/tag catalog. */
export async function importMappingTargetChoices(
  tx: DbTransaction,
  scope: ImportRunRef,
  raw: ImportMappingTargetsQuery,
) {
  const query = importMappingTargetsQuerySchema.parse(raw);
  await requireMappingReview(tx, scope);
  const catalog = destinationCatalog(
    scope,
    query.kind,
    query.kind === 'field' ? query.externalValue : null,
  );
  const rows = z.array(catalogRowSchema.extend({ selection: z.unknown() })).parse(
    await tx.execute(sql`
    SELECT choices.id, choices.label, choices.name_ar, choices.detail,
      jsonb_build_object('kind', ${query.kind}::text, 'externalValue', ${query.externalValue}::text,
        'target', choices.target) AS selection
    FROM (${catalog}) choices
    WHERE position(lower(${query.search}) in lower(concat_ws(' ', choices.id, choices.label, choices.name_ar, choices.detail))) > 0
      AND ${query.after === undefined ? sql`TRUE` : sql`choices.id COLLATE "C" > ${query.after}::text COLLATE "C"`}
    ORDER BY choices.id COLLATE "C" LIMIT ${query.limit + 1}
  `),
  );
  const page = rows.slice(0, query.limit);
  return importMappingTargetsSchema.parse({
    choices: page.map((row) => ({
      id: row.id,
      label: row.label,
      nameAr: row.name_ar,
      detail: row.detail,
      selection: row.selection,
    })),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  });
}

/**
 * Names the destinations of one page of mappings in a single query, so a closed picker can show
 * them without searching the catalog. A destination outside this brand's catalog stays unnamed.
 */
export async function importMappingChoices(
  tx: DbTransaction,
  scope: ImportRunRef,
  kind: ImportMapping['kind'],
  mappings: readonly ImportMapping[],
): Promise<(mapping: ImportMapping | null) => ImportMappingTargetChoice | null> {
  const ids = [
    ...new Set(mappings.map(importMappingChoiceId).filter((id): id is string => id !== null)),
  ];
  const rows = ids.length
    ? z.array(catalogRowSchema).parse(
        await tx.execute(sql`
    SELECT choices.id, choices.label, choices.name_ar, choices.detail
    FROM (${destinationCatalog(scope, kind, null)}) choices
    WHERE choices.id IN (${sql.join(
      ids.map((id) => sql`${id}::text`),
      sql`, `,
    )})
  `),
      )
    : [];
  const named = new Map(rows.map((row) => [row.id, row]));
  return (mapping) => {
    const id = importMappingChoiceId(mapping);
    const row = id === null ? undefined : named.get(id);
    return mapping && row
      ? importMappingTargetChoiceSchema.parse({
          id: row.id,
          label: row.label,
          nameAr: row.name_ar,
          detail: row.detail,
          selection: mapping,
        })
      : null;
  };
}

export async function importMappingFieldDefinition(
  tx: DbTransaction,
  scope: ImportRunRef,
  externalId: string,
) {
  await requireMappingReview(tx, scope);
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'field'),
        eq(importRecords.externalId, externalId),
      ),
    )
    .limit(1);
  if (!row) throw new ImportLoadError('target-unavailable');
  const source = validatedStagedRecord(row);
  if (source.entity !== 'field') throw new ImportLoadError('mapping-invalid');
  return source.payload;
}
