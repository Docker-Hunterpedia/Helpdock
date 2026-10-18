import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { type TicketInventory, ticketInventoryEntrySchema } from '../ticket-inventory.js';
import {
  initialZohoArchiveScan,
  readZohoArchiveScan,
  zohoArchiveScanSchema,
} from './archive-scan.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema, zohoTicketIndexSchema } from './contracts.js';

const windowSchema = z
  .strictObject({ start: z.iso.datetime(), end: z.iso.datetime() })
  .refine((window) => Date.parse(window.start) <= Date.parse(window.end));
export const zohoTicketScanSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('archives'), archive: zohoArchiveScanSchema }),
  z.strictObject({
    stage: z.literal('active'),
    from: z.int().min(0).max(2147483647),
    ids: z.array(zohoIdSchema).max(100),
    offset: z.int().min(0).max(100),
    terminal: z.boolean(),
    window: windowSchema.nullable(),
    pending: z.array(windowSchema).max(64),
    lastTime: z.iso.datetime().nullable(),
  }),
  z.strictObject({
    stage: z.literal('inventory'),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    after: zohoIdSchema.nullable(),
  }),
]);
export type ZohoTicketScan = z.infer<typeof zohoTicketScanSchema>;

function inventoryCursor(inventory: TicketInventory): ZohoTicketScan {
  return zohoTicketScanSchema.parse({
    stage: 'inventory',
    fingerprint: inventory.fingerprint,
    after: null,
  });
}
export function initialZohoTicketScan(
  inventory?: TicketInventory,
  since?: Date,
  now = new Date(),
): ZohoTicketScan {
  return inventory?.mode === 'complete'
    ? inventoryCursor(inventory)
    : zohoTicketScanSchema.parse({
        stage: 'active',
        from: 0,
        ids: [],
        offset: 0,
        terminal: false,
        pending: [],
        lastTime: null,
        window: since ? { start: since.toISOString(), end: now.toISOString() } : null,
      });
}

type ScanResult = { id: string | null; next: ZohoTicketScan | null; archivedDepartmentId?: string };

/** Empty pages are durable scan progress; each native ID is hydrated only after its own checkpoint. */
export async function readZohoTicketScan(
  client: ZohoDeskClient,
  cursor: ZohoTicketScan,
  inventory?: TicketInventory,
): Promise<ScanResult> {
  if (cursor.stage === 'archives') {
    const step = await readZohoArchiveScan(client, cursor.archive);
    return {
      id: step.id,
      next: step.next === null ? null : { stage: 'archives', archive: step.next },
      ...(step.id !== null ? { archivedDepartmentId: step.departmentId } : {}),
    };
  }
  if (cursor.stage === 'inventory') {
    if (!inventory || inventory.fingerprint !== cursor.fingerprint)
      throw new ConnectorError('invalid-response');
    const raw = await inventory.next(cursor.after);
    if (raw === null) return { id: null, next: null };
    const entry = ticketInventoryEntrySchema.parse(raw);
    const id = zohoIdSchema.parse(entry.externalId);
    if (cursor.after !== null && id <= cursor.after) throw new ConnectorError('invalid-response');
    // Desk documents the same detail resource, not a distinct archived/{id} route.
    return { id, next: { ...cursor, after: id } };
  }
  if (cursor.offset > cursor.ids.length) throw new ConnectorError('invalid-response');
  const id = cursor.ids[cursor.offset];
  if (id !== undefined) return { id, next: { ...cursor, offset: cursor.offset + 1 } };
  if (cursor.terminal) {
    const [window, ...pending] = cursor.pending;
    if (window)
      return {
        id: null,
        next: {
          ...cursor,
          window,
          pending,
          from: 0,
          ids: [],
          offset: 0,
          terminal: false,
          lastTime: null,
        },
      };
    return {
      id: null,
      next: inventory
        ? inventoryCursor(inventory)
        : { stage: 'archives', archive: initialZohoArchiveScan() },
    };
  }
  const query: Record<string, string> = {
    from: String(cursor.from),
    limit: '100',
    sortBy: 'createdTime',
  };
  const page = await client.list(
    '/api/v1/tickets',
    z.object({ data: z.array(zohoTicketIndexSchema).max(100) }),
    query,
  );
  if (new Set(page.data.map((row) => row.id)).size !== page.data.length)
    throw new ConnectorError('invalid-response');
  let lastTime = cursor.lastTime;
  for (const row of page.data) {
    const time = new Date(row.createdTime).toISOString();
    if (lastTime && time < lastTime) throw new ConnectorError('invalid-response');
    lastTime = time;
  }
  return {
    id: null,
    next: zohoTicketScanSchema.parse({
      ...cursor,
      from: cursor.from + page.data.length,
      ids: page.data
        .filter(
          (row) =>
            !cursor.window || Date.parse(row.modifiedTime) >= Date.parse(cursor.window.start),
        )
        .map((row) => row.id),
      offset: 0,
      terminal: page.data.length < 100,
      lastTime,
    }),
  };
}
