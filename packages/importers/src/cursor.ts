import { z } from 'zod';
import type { ImportCursor } from './connector.js';
import { ConnectorError } from './errors.js';

const cursorSchema = z.record(z.string(), z.json());

/** Validate the exported checkpoint, including nested optional vendor state, as actual JSON. */
export function validatedImportCursor(raw: unknown): ImportCursor {
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError('invalid-response');
  return parsed.data;
}
