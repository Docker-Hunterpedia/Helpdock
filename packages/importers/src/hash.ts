import { createHash } from 'node:crypto';
import { z } from 'zod';

type JsonValue = z.infer<ReturnType<typeof z.json>>;

function canonicalJson(payload: JsonValue): string {
  if (payload === null || typeof payload !== 'object') return JSON.stringify(payload);
  if (Array.isArray(payload)) return `[${payload.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(payload)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(payload[key] as JsonValue)}`)
    .join(',')}}`;
}

/** Object key order is irrelevant; arrays and source timestamps retain their meaning. */
export function serializeImportValue(payload: unknown): string {
  return canonicalJson(z.json().parse(payload));
}

export function hashImportValue(payload: unknown): string {
  return createHash('sha256').update(serializeImportValue(payload)).digest('hex');
}
