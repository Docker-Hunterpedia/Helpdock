import type { DbTransaction } from '@helpdock/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ImportScope, importSourceAccountKey } from '../loader/external-ids.js';

const sampleSchema = z.strictObject({
  entity: z.enum(['contact', 'organization']),
  externalId: z.string().min(1).max(200),
  total: z.coerce.number().int().nonnegative(),
});
const reportSchema = z.strictObject({
  issueCount: z.int().nonnegative(),
  issues: z
    .array(
      z.strictObject({
        entity: z.enum(['contact', 'organization']),
        externalId: z.string().min(1).max(200),
        code: z.enum(['contact-plan-ambiguous', 'organization-plan-ambiguous']),
      }),
    )
    .max(100),
});

/** Postgres compares compact staged claims; no complete profile/identifier graph is held in the worker. */
export async function validateImportIdentityPlan(tx: DbTransaction, scope: ImportScope) {
  await importSourceAccountKey(tx, scope);
  const rows = z
    .array(sampleSchema)
    .max(100)
    .parse(
      await tx.execute(sql`
    WITH claims AS (
      SELECT r.entity, r.external_id, r.dry_run_identity->>'destination' AS destination, claim
      FROM import_records r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.dry_run_identity->'claims') AS claim
      WHERE r.brand_id = ${scope.brandId}::uuid AND r.run_id = ${scope.runId}::uuid
        AND r.entity IN ('contact', 'organization')
        AND r.dry_run_identity->>'version' = '1'
        AND r.dry_run_identity->>'inputHash' = r.payload_hash
    ), conflicts AS (
      SELECT entity, claim FROM claims GROUP BY entity, claim
      HAVING count(DISTINCT destination) > 1
    ), sources AS (
      SELECT DISTINCT c.entity, c.external_id FROM claims c
      JOIN conflicts f ON f.entity = c.entity AND f.claim = c.claim
    )
    SELECT entity, external_id AS "externalId", count(*) OVER()::text AS total
    FROM sources ORDER BY entity, external_id LIMIT 100
  `),
    );
  return reportSchema.parse({
    issueCount: rows[0]?.total ?? 0,
    issues: rows.map((row) => ({
      entity: row.entity,
      externalId: row.externalId,
      code: row.entity === 'contact' ? 'contact-plan-ambiguous' : 'organization-plan-ambiguous',
    })),
  });
}
