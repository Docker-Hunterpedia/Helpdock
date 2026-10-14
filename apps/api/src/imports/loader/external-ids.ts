import { type DbTransaction, importExternalIds, importRuns } from '@helpdock/db';
import type { ImportEntity, ImportSource } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';

export type ImportScope = { brandId: string; source: ImportSource; runId: string };
export async function importSourceAccountKey(tx: DbTransaction, scope: ImportScope) {
  const [run] = await tx
    .select({ key: importRuns.sourceAccountKey })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, scope.brandId),
        eq(importRuns.id, scope.runId),
        eq(importRuns.source, scope.source),
      ),
    );
  if (!run) throw new ImportLoadError('mapping-invalid');
  return run.key;
}
export async function importedIdentity(
  tx: DbTransaction,
  scope: ImportScope,
  entity: ImportEntity,
  externalId: string,
) {
  const accountKey = await importSourceAccountKey(tx, scope);
  const [identity] = await tx
    .select()
    .from(importExternalIds)
    .where(
      and(
        eq(importExternalIds.brandId, scope.brandId),
        eq(importExternalIds.source, scope.source),
        eq(importExternalIds.sourceAccountKey, accountKey),
        eq(importExternalIds.entity, entity),
        eq(importExternalIds.externalId, externalId),
      ),
    );
  return identity;
}

export async function rememberImported(
  tx: DbTransaction,
  request: typeof importExternalIds.$inferInsert & { runId: string },
): Promise<void> {
  const { runId, ...input } = request;
  const sourceAccountKey = await importSourceAccountKey(tx, { ...input, runId });
  await tx
    .insert(importExternalIds)
    .values({ ...input, sourceAccountKey })
    .onConflictDoUpdate({
      target: [
        importExternalIds.brandId,
        importExternalIds.source,
        importExternalIds.sourceAccountKey,
        importExternalIds.entity,
        importExternalIds.externalId,
      ],
      set: {
        payloadHash: input.payloadHash,
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.sourceNumber === undefined ? {} : { sourceNumber: input.sourceNumber }),
      },
    });
}
