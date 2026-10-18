import { customFieldDefs, type DbTransaction, importExternalIds } from '@helpdock/db';
import type { ImportMapping } from '@helpdock/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { type ImportScope, importSourceAccountKey } from '../loader/external-ids.js';
import { validateFieldCreationPlan } from './field-creation-plan.js';

/** Read-only snapshot of existing definitions and bindings, scoped exactly like field loading. */
export async function validateImportFieldPlan(
  tx: DbTransaction,
  scope: ImportScope,
  mappings: ImportMapping[],
) {
  const account = await importSourceAccountKey(tx, scope);
  const existing = await tx
    .select({ id: customFieldDefs.id, target: customFieldDefs.target, key: customFieldDefs.key })
    .from(customFieldDefs)
    .where(eq(customFieldDefs.brandId, scope.brandId));
  const externalIds = mappings
    .filter((mapping) => mapping.kind === 'field' && mapping.target.kind !== 'skip')
    .map((mapping) => mapping.externalValue);
  const bindings = new Map<string, string>();
  for (let offset = 0; offset < externalIds.length; offset += 500) {
    const rows = await tx
      .select({ externalId: importExternalIds.externalId, id: importExternalIds.helpdockId })
      .from(importExternalIds)
      .where(
        and(
          eq(importExternalIds.brandId, scope.brandId),
          eq(importExternalIds.source, scope.source),
          eq(importExternalIds.sourceAccountKey, account),
          eq(importExternalIds.entity, 'field'),
          inArray(importExternalIds.externalId, externalIds.slice(offset, offset + 500)),
        ),
      );
    for (const row of rows) bindings.set(row.externalId, row.id);
  }
  return validateFieldCreationPlan(mappings, existing, bindings);
}
