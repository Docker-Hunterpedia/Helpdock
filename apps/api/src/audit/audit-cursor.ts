import { z } from 'zod';

/**
 * Keyset pagination for the audit log viewer (M3-08), newest first by
 * `(created_at, id)`. Opaque to the client, and not a token: it grants nothing,
 * since every row it can reach is one the install scope already reads. It is
 * validated all the same, because it reaches a comparison against typed
 * columns and a malformed one should answer 400, not 500.
 */

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
export type AuditCursor = z.infer<typeof cursorSchema>;

export class InvalidAuditCursorError extends Error {
  constructor() {
    super('That cursor is not one this api issued');
    this.name = 'InvalidAuditCursorError';
  }
}

export const encodeAuditCursor = (cursor: AuditCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodeAuditCursor = (encoded: string): AuditCursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidAuditCursorError();
  }

  const cursor = cursorSchema.safeParse(parsed);
  if (!cursor.success) {
    throw new InvalidAuditCursorError();
  }

  return cursor.data;
};
