import { type DbTransaction, importExternalIds } from '@helpdock/db';
import type { ImportEntity, ImportSource } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';

export type ImportScope = { brandId: string; source: ImportSource };
export async function importedIdentity(
  tx: DbTransaction,
  scope: ImportScope,
  entity: ImportEntity,
  externalId: string,
) {
  const [identity] = await tx
    .select()
    .from(importExternalIds)
    .where(
      and(
        eq(importExternalIds.brandId, scope.brandId),
        eq(importExternalIds.source, scope.source),
        eq(importExternalIds.entity, entity),
        eq(importExternalIds.externalId, externalId),
      ),
    );
  return identity;
}

export async function rememberImported(
  tx: DbTransaction,
  input: typeof importExternalIds.$inferInsert,
): Promise<void> {
  await tx
    .insert(importExternalIds)
    .values(input)
    .onConflictDoUpdate({
      target: [
        importExternalIds.brandId,
        importExternalIds.source,
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
