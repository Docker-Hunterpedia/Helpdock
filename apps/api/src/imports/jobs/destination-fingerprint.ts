import { createHash } from 'node:crypto';
import { type DbTransaction, importRuns } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportRunRef, importRunRefSchema, lockImportBrand } from './claims.js';

// These are fixed identifiers, never request-supplied table or column names.
const destinationTables = [
  'accounts',
  'contacts',
  'contact_identities',
  'custom_field_defs',
  'departments',
  'teams',
  'ticket_statuses',
  'tags',
  'user_brand_roles',
  'hc_categories',
  'hc_sections',
  'hc_articles',
] as const;
const revisionPageSchema = z.array(z.strictObject({ id: z.uuid(), revision: z.string() })).max(500);

async function tableRevisions(
  tx: DbTransaction,
  brandId: string,
  table: (typeof destinationTables)[number],
  digest: ReturnType<typeof createHash>,
) {
  let after: string | undefined;
  while (true) {
    const rows = revisionPageSchema.parse(
      await tx.execute(sql`
      SELECT id, xmin::text AS revision FROM ${sql.identifier(table)}
      WHERE brand_id = ${brandId} ${after ? sql`AND id > ${after}::uuid` : sql``}
      ORDER BY id LIMIT 500
    `),
    );
    for (const row of rows) digest.update(hashImportValue({ table, ...row }));
    const last = rows.at(-1);
    if (!last) return;
    after = last.id;
  }
}

async function staffRevisions(tx: DbTransaction, digest: ReturnType<typeof createHash>) {
  let after: string | undefined;
  // Invitation uniqueness is install-wide. Row revisions also catch changes
  // reverted during validation; no email, password or session values leave SQL.
  while (true) {
    const rows = revisionPageSchema.parse(
      await tx.execute(sql`
      SELECT id, xmin::text AS revision FROM users
      ${after ? sql`WHERE id > ${after}::uuid` : sql``} ORDER BY id LIMIT 500
    `),
    );
    for (const row of rows) digest.update(hashImportValue({ table: 'users', ...row }));
    const last = rows.at(-1);
    if (!last) return;
    after = last.id;
  }
}

async function ledgerRevisions(
  tx: DbTransaction,
  scope: ImportRunRef,
  digest: ReturnType<typeof createHash>,
) {
  const [run] = await tx
    .select({ source: importRuns.source, account: importRuns.sourceAccountKey })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!run) throw new ImportLoadError('target-unavailable');
  const pageSchema = z
    .array(z.strictObject({ entity: z.string(), externalId: z.string(), revision: z.string() }))
    .max(500);
  let after: { entity: string; externalId: string } | undefined;
  while (true) {
    const rows = pageSchema.parse(
      await tx.execute(sql`
      SELECT entity, external_id AS "externalId", xmin::text AS revision FROM import_external_ids
      WHERE brand_id = ${scope.brandId} AND source = ${run.source} AND source_account_key = ${run.account}
      ${after ? sql`AND (entity, external_id) > (${after.entity}::import_entity, ${after.externalId})` : sql``}
      ORDER BY entity, external_id LIMIT 500
    `),
    );
    for (const row of rows)
      digest.update(hashImportValue({ table: 'import_external_ids', ...row }));
    const last = rows.at(-1);
    if (!last) return;
    after = last;
  }
}

/** Conservative destination snapshot: bounded metadata pages, no profile payloads or secrets retained. */
export async function importDestinationFingerprint(tx: DbTransaction, raw: ImportRunRef) {
  const scope = importRunRefSchema.parse(raw);
  await lockImportBrand(tx, scope.brandId);
  const digest = createHash('sha256').update(
    hashImportValue({ version: 1, brandId: scope.brandId }),
  );
  for (const table of destinationTables) await tableRevisions(tx, scope.brandId, table, digest);
  await staffRevisions(tx, digest);
  await ledgerRevisions(tx, scope, digest);
  const settings = z
    .array(z.strictObject({ revision: z.string() }))
    .max(1)
    .parse(
      await tx.execute(sql`SELECT xmin::text AS revision FROM brands WHERE id = ${scope.brandId}`),
    );
  if (!settings.length) throw new ImportLoadError('target-unavailable');
  digest.update(hashImportValue(settings));
  return digest.digest('hex');
}
