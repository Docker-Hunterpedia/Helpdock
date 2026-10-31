import { type CustomFieldRule, customValuesSchema } from '@helpdock/schemas';
import { z } from 'zod';
import { ImportLoadError } from './contracts.js';
import type { FieldLoad } from './field-contracts.js';

export type ImportedFieldBinding = {
  source: FieldLoad['record'];
  destination: CustomFieldRule | null;
};

/** A null destination is a confirmed skip, never an inferred treatment of an unknown key. */
export function mappedImportedCustom(request: {
  custom: Record<string, unknown>;
  bindings: readonly ImportedFieldBinding[];
  definitions: readonly CustomFieldRule[];
  operation: 'create' | 'patch';
}) {
  const custom = z.record(z.string(), z.json()).parse(request.custom);
  const bySourceKey = new Map<string, ImportedFieldBinding>();
  const destinationKeys = new Set<string>();
  for (const binding of request.bindings) {
    if (bySourceKey.has(binding.source.key)) throw new ImportLoadError('mapping-invalid');
    if (binding.destination) {
      if (destinationKeys.has(binding.destination.key))
        throw new ImportLoadError('mapping-invalid');
      destinationKeys.add(binding.destination.key);
    }
    bySourceKey.set(binding.source.key, binding);
  }
  const mapped = new Map<string, z.infer<ReturnType<typeof z.json>>>();
  for (const [sourceKey, value] of Object.entries(custom)) {
    const binding = bySourceKey.get(sourceKey);
    if (!binding) throw new ImportLoadError('mapping-invalid');
    if (!binding.destination) continue;
    const destinationKey = binding.destination.key;
    mapped.set(destinationKey, value);
  }
  // Not an import destination: see `validatedImportedCustom`.
  const validated = customValuesSchema(
    request.definitions.filter((definition) => definition.type !== 'person'),
    {
      partial: request.operation === 'patch',
    },
  ).parse(Object.fromEntries(mapped));
  return z
    .record(z.string(), z.json())
    .parse(
      Object.fromEntries(Object.entries(validated).filter(([, value]) => value !== undefined)),
    );
}
