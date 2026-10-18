import {
  type Db,
  type DbTransaction,
  importFiles,
  importRuns,
  importTicketInventory,
} from '@helpdock/db';
import { ConnectorError, hashImportValue, type TicketInventory } from '@helpdock/importers';
import {
  importInventoryIdentitySchema,
  importInventoryLocationSchema,
  importInventoryMappingSchema,
  importInventoryValidationSchema,
} from '@helpdock/schemas';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { type ImportRunRef, importRunRefSchema } from './claims.js';

/** Load a small sealed manifest; the native IDs stay in Postgres throughout extraction. */
export async function importTicketInventoryManifest(
  tx: DbTransaction,
  raw: ImportRunRef,
  rawMode: TicketInventory['mode'],
) {
  const scope = importRunRefSchema.parse(raw);
  const mode = importInventoryIdentitySchema.shape.mode.parse(rawMode);
  const [account] = await tx
    .select({ source: importRuns.source, key: importRuns.sourceAccountKey })
    .from(importRuns)
    .where(and(eq(importRuns.brandId, scope.brandId), eq(importRuns.id, scope.runId)));
  if (!account || account.key === '0'.repeat(64)) throw new ConnectorError('invalid-response');
  const rows = await tx
    .select({
      id: importFiles.id,
      revision: importFiles.revision,
      sourceKey: importFiles.sourceKey,
      sha256: importFiles.sha256,
      format: importFiles.format,
      entity: importFiles.entity,
      status: importFiles.status,
      inventoryMapping: importFiles.inventoryMapping,
      inventoryValidation: importFiles.inventoryValidation,
      recordCount: importFiles.recordCount,
    })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.brandId, scope.brandId),
        eq(importFiles.runId, scope.runId),
        ne(importFiles.status, 'discarded'),
      ),
    )
    .orderBy(importFiles.id)
    .limit(101);
  if (!rows.length || rows.length > 100) throw new ConnectorError('invalid-response');
  const files = rows.map((file) => {
    const mapping = importInventoryMappingSchema.parse(file.inventoryMapping);
    const validation = importInventoryValidationSchema.parse(file.inventoryValidation);
    if (
      file.format !== 'csv' ||
      file.entity !== 'ticket' ||
      file.status !== 'ready' ||
      mapping.idColumn === null ||
      !file.sourceKey?.startsWith(
        `brands/${scope.brandId}/imports/${scope.runId}/files/${file.id}/sealed-`,
      ) ||
      !file.sha256 ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      file.recordCount !== validation.records
    )
      throw new ConnectorError('invalid-response');
    return {
      id: file.id,
      revision: file.revision,
      sourceKey: file.sourceKey,
      sha256: file.sha256,
      mapping,
      records: validation.records,
    };
  });
  const counts = z
    .array(z.object({ id: z.uuid(), records: z.coerce.number().int().nonnegative().safe() }))
    .parse(
      await tx.execute(sql`SELECT f.id, count(i.id)::text AS records FROM ${importFiles} f
      LEFT JOIN ${importTicketInventory} i ON i.brand_id=f.brand_id AND i.run_id=f.run_id AND i.file_id=f.id
        AND i.revision=f.revision AND i.source_hash=f.sha256
      WHERE f.brand_id=${scope.brandId}::uuid AND f.run_id=${scope.runId}::uuid AND f.status <> 'discarded'
      GROUP BY f.id`),
    );
  const actual = new Map(counts.map((row) => [row.id, row.records]));
  if (files.some((file) => actual.get(file.id) !== file.records))
    throw new ConnectorError('invalid-response');
  // Catch incompatible files before an admin approves extraction, rather than
  // discovering the ambiguity after earlier tickets have already been staged.
  const conflicts = z
    .array(z.object({ external_id: z.string() }))
    .max(1)
    .parse(
      await tx.execute(sql`SELECT i.external_id FROM ${importTicketInventory} i
      JOIN ${importFiles} f ON f.brand_id=i.brand_id AND f.run_id=i.run_id AND f.id=i.file_id
        AND f.revision=i.revision AND f.sha256=i.source_hash
      WHERE i.brand_id=${scope.brandId}::uuid AND i.run_id=${scope.runId}::uuid AND f.status='ready'
      GROUP BY i.external_id HAVING count(DISTINCT i.location) <> 1
        OR NOT bool_and(i.location = f.inventory_mapping->>'location') LIMIT 1`),
    );
  if (conflicts.length) throw new ConnectorError('invalid-response');
  return { files, fingerprint: hashImportValue({ version: 1, mode, ...scope, account, files }) };
}

const pageSchema = z
  .array(
    z.object({
      external_id: z.string().min(1).max(200),
      locations: z.array(importInventoryLocationSchema).min(1).max(3),
      valid: z.boolean(),
    }),
  )
  .max(1);

export async function createImportTicketInventory(
  deps: { db: Db },
  scope: ImportRunRef,
  mode: TicketInventory['mode'],
): Promise<TicketInventory> {
  const manifest = await withSystemJob(deps.db, scope.brandId, 'import.inventory', (tx) =>
    importTicketInventoryManifest(tx, scope, mode),
  );
  return {
    mode,
    fingerprint: manifest.fingerprint,
    next: async (after) => {
      const rows = await withSystemJob(deps.db, scope.brandId, 'import.inventory', async (tx) =>
        pageSchema.parse(
          await tx.execute(sql`SELECT i.external_id, array_agg(DISTINCT i.location)::text[] AS locations,
        bool_and(i.location = f.inventory_mapping->>'location') AS valid
        FROM ${importTicketInventory} i JOIN ${importFiles} f
          ON f.brand_id=i.brand_id AND f.run_id=i.run_id AND f.id=i.file_id
          AND f.revision=i.revision AND f.sha256=i.source_hash
        WHERE i.brand_id=${scope.brandId}::uuid AND i.run_id=${scope.runId}::uuid AND f.status='ready'
          AND f.inventory_mapping IS NOT NULL
          AND ${after === null ? sql`TRUE` : sql`i.external_id COLLATE "C" > ${after}::text COLLATE "C"`}
        GROUP BY i.external_id ORDER BY i.external_id COLLATE "C" LIMIT 1`),
        ),
      );
      const row = rows[0];
      if (!row) return null;
      if (!row.valid || row.locations.length !== 1 || !row.locations[0])
        throw new ConnectorError('invalid-response');
      return { externalId: row.external_id, location: row.locations[0] };
    },
  };
}
