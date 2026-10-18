import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { serializeImportValue } from '../hash.js';
import type { ZohoField } from './fields-export.js';

export function zohoCustomValues(
  fields: readonly ZohoField[],
  values: Record<string, unknown>,
): Record<string, z.infer<ReturnType<typeof z.json>>> {
  const definitions = new Map(fields.map((field) => [field.payload.key, field.payload]));
  const normalized: [string, z.infer<ReturnType<typeof z.json>>][] = [];
  for (const [key, value] of Object.entries(values)) {
    const definition = definitions.get(key);
    if (!definition) throw new ConnectorError('invalid-response');
    normalized.push([key, normalizedValue(definition, value)]);
  }
  return Object.fromEntries(normalized);
}

function normalizedValue(
  definition: ZohoField['payload'],
  value: unknown,
): z.infer<ReturnType<typeof z.json>> {
  if (value === null) return null;
  switch (definition.type) {
    case 'checkbox':
      if (typeof value === 'boolean') return value;
      else if (value === 'true' || value === 'false') return value === 'true';
      else throw new ConnectorError('invalid-response');
    case 'number': {
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)
            ? Number(value)
            : NaN;
      if (!Number.isSafeInteger(number)) throw new ConnectorError('invalid-response');
      return number;
    }
    case 'date': {
      const date = z.iso.date().safeParse(value);
      if (!date.success) throw new ConnectorError('invalid-response');
      return date.data;
    }
    case 'select':
      if (
        typeof value !== 'string' ||
        !definition.options?.some((option) => option.value === value)
      )
        throw new ConnectorError('invalid-response');
      return value;
    case 'multiselect':
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            typeof item !== 'string' ||
            !definition.options?.some((option) => option.value === item),
        )
      )
        throw new ConnectorError('invalid-response');
      return z.array(z.string()).parse(value);
    default:
      refuseUnsafeNumbers(value);
      return typeof value === 'string' ? value : serializeImportValue(value);
  }
}

function refuseUnsafeNumbers(value: unknown): void {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    throw new ConnectorError('invalid-response');
  if (Array.isArray(value)) for (const child of value) refuseUnsafeNumbers(child);
  else if (value !== null && typeof value === 'object')
    for (const child of Object.values(value)) refuseUnsafeNumbers(child);
}
