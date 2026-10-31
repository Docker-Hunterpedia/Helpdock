import { customFieldDefs, type DbTransaction } from '@helpdock/db';
import { type CustomFieldTarget, customValuesSchema, mergeCustomValues } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

/** Imports share the normal field coercions and never store unmapped or mistyped values. */
export async function validatedImportedCustom(
  tx: DbTransaction,
  scope: {
    brandId: string;
    target: CustomFieldTarget;
    custom: Record<string, unknown>;
    operation: 'create' | 'patch';
  },
) {
  const definitions = await tx
    .select()
    .from(customFieldDefs)
    .where(
      and(eq(customFieldDefs.brandId, scope.brandId), eq(customFieldDefs.target, scope.target)),
    );
  // A person is a staff id of this brand; a foreign system has none to give, so
  // a person field is not an import destination and its key is refused as unknown.
  const importable = definitions.filter((definition) => definition.type !== 'person');
  const parsed = customValuesSchema(importable, { partial: scope.operation === 'patch' }).parse(
    scope.custom,
  );
  return z.record(z.string(), z.json()).parse(mergeCustomValues({}, parsed));
}
