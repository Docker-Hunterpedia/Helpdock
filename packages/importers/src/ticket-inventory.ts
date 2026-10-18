import type { ImportSource } from '@helpdock/schemas';
import { importInventoryEntrySchema, importInventoryIdentitySchema } from '@helpdock/schemas';
import type { z } from 'zod';

export const ticketInventoryEntrySchema = importInventoryEntrySchema;
export const ticketInventoryIdentitySchema = importInventoryIdentitySchema;

/** A sealed source export supplies IDs, never URLs or credentials. Reads use strict keyset ordering. */
export type TicketInventory = z.infer<typeof ticketInventoryIdentitySchema> & {
  next(after: string | null): Promise<z.infer<typeof ticketInventoryEntrySchema> | null>;
};

export function validInventoryTicketId(source: ImportSource, externalId: string): boolean {
  if (!/^[1-9]\d{0,199}$/.test(externalId)) return false;
  if (source === 'zohodesk') return true;
  return source === 'freshdesk' && Number.isSafeInteger(Number(externalId));
}
