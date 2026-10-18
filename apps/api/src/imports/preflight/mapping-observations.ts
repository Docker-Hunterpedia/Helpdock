import type { ImportMapping } from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';
import type { ImportRunRef } from '../jobs/claims.js';

function ticketValues(scope: ImportRunRef, key: string): SQL {
  return sql`SELECT coalesce(r.payload->>${key}, '') AS value, 1 AS hits FROM import_records r
    WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid AND r.entity = 'ticket'`;
}

/** Only ticket metadata and small source definitions are projected; message bodies never leave Postgres. */
export function observedImportValues(scope: ImportRunRef, kind: ImportMapping['kind']): SQL {
  switch (kind) {
    case 'status':
    case 'priority':
    case 'channel':
      return ticketValues(scope, kind);
    case 'group':
      return sql`${ticketValues(scope, 'groupExternalId')} UNION ALL
      SELECT r.external_id AS value, 0 AS hits FROM import_records r
      WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid AND r.entity = 'group'`;
    case 'agent':
      return sql`SELECT r.external_id AS value, 0 AS hits FROM import_records r
      WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid AND r.entity = 'user'
        AND r.payload->>'kind' = 'agent'
      UNION ALL SELECT r.payload->>'assigneeExternalId' AS value, 1 AS hits FROM import_records r
      WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid AND r.entity = 'ticket'
        AND r.payload->>'assigneeExternalId' IS NOT NULL`;
    case 'field':
      return sql`SELECT r.external_id AS value, 0 AS hits FROM import_records r
      WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid AND r.entity = 'field'`;
    case 'tag':
      return sql`SELECT jsonb_array_elements_text(coalesce(r.payload->'tags', '[]'::jsonb)) AS value, 1 AS hits
      FROM import_records r WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid AND r.entity = 'ticket'
      UNION ALL SELECT r.payload->>'name' AS value, 0 AS hits FROM import_records r
      WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid AND r.entity = 'tag'`;
  }
}

export function observedValueMetadata(scope: ImportRunRef, kind: ImportMapping['kind']): SQL {
  if (kind === 'status')
    return sql`(SELECT jsonb_build_object('label', min(d.payload->>'statusLabel'))
    FROM import_records d WHERE d.brand_id = ${scope.brandId}::uuid AND d.run_id = ${scope.runId}::uuid
      AND d.entity = 'ticket' AND d.payload->>'status' = observed.value
      AND d.payload->>'statusLabel' IS NOT NULL
    HAVING count(DISTINCT d.payload->>'statusLabel') = 1)`;
  if (!['group', 'agent', 'field'].includes(kind)) return sql`NULL::jsonb`;
  const entity = kind === 'agent' ? 'user' : kind;
  return sql`(SELECT CASE WHEN ${kind} = 'agent' THEN jsonb_strip_nulls(jsonb_build_object(
      'name', d.payload->'name', 'email', d.payload->'email', 'kind', d.payload->'kind', 'active', d.payload->'active'))
    WHEN ${kind} = 'field' THEN jsonb_build_object('label', d.payload->'label', 'target', d.payload->'target',
      'key', d.payload->'key', 'type', d.payload->'type', 'optionsCount', jsonb_array_length(coalesce(d.payload->'options', '[]'::jsonb)))
    ELSE jsonb_build_object('name', d.payload->'name') END
    FROM import_records d WHERE d.brand_id = ${scope.brandId}::uuid AND d.run_id = ${scope.runId}::uuid
      AND d.entity = ${entity}::import_entity AND d.external_id = observed.value LIMIT 1)`;
}
