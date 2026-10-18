import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ImportSnapshotScope } from '../http.js';
import {
  type TicketInventory,
  ticketInventoryEntrySchema,
  ticketInventoryIdentitySchema,
} from '../ticket-inventory.js';
import type { FreshdeskClient } from './client.js';
import { freshdeskTicketSchema } from './contracts.js';

export const freshdeskInventoryCursorSchema = z.strictObject({
  kind: z.literal('inventory'),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  after: z.string().min(1).max(200).nullable(),
});
const numericId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

export function initialFreshdeskInventory(inventory: TicketInventory) {
  const identity = ticketInventoryIdentitySchema.parse(inventory);
  return { kind: 'inventory' as const, fingerprint: identity.fingerprint, after: null };
}

/** One hydrated ticket per checkpoint fits the worker's bounded request budget. */
export async function readFreshdeskInventory(
  client: FreshdeskClient,
  checkpoint: z.infer<typeof freshdeskInventoryCursorSchema>,
  inventory?: TicketInventory,
  snapshot?: ImportSnapshotScope,
) {
  if (
    !inventory ||
    ticketInventoryIdentitySchema.parse(inventory).fingerprint !== checkpoint.fingerprint
  )
    throw new ConnectorError('invalid-response');
  const entry = await inventory.next(checkpoint.after);
  if (entry === null) return { rows: [], next: null };
  const parsed = ticketInventoryEntrySchema.parse(entry);
  const id = numericId.parse(parsed.externalId);
  if (checkpoint.after !== null && id <= checkpoint.after)
    throw new ConnectorError('invalid-response');
  let archived = parsed.location === 'archived';
  let row: z.infer<typeof freshdeskTicketSchema>;
  try {
    row = await client.json(
      `/api/v2/tickets/${archived ? 'archived/' : ''}${id}`,
      freshdeskTicketSchema,
      {},
      snapshot,
    );
  } catch (error) {
    if (
      parsed.location !== 'auto' ||
      !(error instanceof ConnectorError) ||
      error.code !== 'record-unavailable'
    )
      throw error;
    archived = true;
    row = await client.json(`/api/v2/tickets/archived/${id}`, freshdeskTicketSchema, {}, snapshot);
  }
  if (String(row.id) !== id || row.deleted || row.spam)
    throw new ConnectorError('invalid-response');
  return {
    rows: [{ ...row, archived: archived || row.archived === true }],
    next: { ...checkpoint, after: id },
  };
}
