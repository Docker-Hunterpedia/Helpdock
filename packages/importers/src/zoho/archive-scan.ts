import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import { RUN_SNAPSHOT } from '../http.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';

const fingerprint = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
export const zohoArchiveScanSchema = z.strictObject({
  enabled: z.boolean(),
  departmentFrom: z.int().min(0).max(2147483647),
  departmentIds: z.array(zohoIdSchema).max(200),
  departmentOffset: z.int().min(0).max(200),
  departmentsTerminal: z.boolean(),
  departmentBoundary: zohoIdSchema.nullable(),
  previousDepartments: fingerprint,
  from: z.int().min(0).max(4999),
  ids: z.array(zohoIdSchema).max(100),
  offset: z.int().min(0).max(100),
  terminal: z.boolean(),
  boundary: zohoIdSchema.nullable(),
  previousPage: fingerprint,
});
type ArchiveScan = z.infer<typeof zohoArchiveScanSchema>;
type ScanResult =
  | { id: null; next: ArchiveScan | null }
  | { id: string; departmentId: string; next: ArchiveScan };
const departmentPageSchema = z.object({
  data: z
    .array(
      z.object({
        id: zohoIdSchema,
        isEnabled: z.boolean(),
      }),
    )
    .max(200),
});
const archivePageSchema = z.object({
  data: z
    .array(
      z.object({
        id: zohoIdSchema,
        departmentId: zohoIdSchema,
        isArchived: z.literal(true),
      }),
    )
    .max(100),
});

const emptyTicketPage = {
  from: 0,
  ids: [],
  offset: 0,
  terminal: false,
  boundary: null,
  previousPage: null,
} as const;

export function initialZohoArchiveScan(): ArchiveScan {
  return {
    enabled: true,
    departmentFrom: 0,
    departmentIds: [],
    departmentOffset: 0,
    departmentsTerminal: false,
    departmentBoundary: null,
    previousDepartments: null,
    ...emptyTicketPage,
    ids: [],
  };
}

/** Offset pages overlap one ID so inserts/removals at a boundary cannot silently skip history. */
function checkedPage(
  ids: string[],
  expectedBoundary: string | null,
  previousFingerprint: string | null,
): { ids: string[]; fingerprint: string } {
  const fingerprint = hashImportValue(ids);
  if (
    new Set(ids).size !== ids.length ||
    (expectedBoundary !== null && ids[0] !== expectedBoundary) ||
    (ids.length > 1 && fingerprint === previousFingerprint)
  )
    throw new ConnectorError('invalid-response');
  return { ids: expectedBoundary === null ? ids : ids.slice(1), fingerprint };
}

async function departmentPage(client: ZohoDeskClient, cursor: ArchiveScan): Promise<ScanResult> {
  if (cursor.departmentsTerminal) {
    return {
      id: null,
      next: cursor.enabled ? { ...initialZohoArchiveScan(), enabled: false } : null,
    };
  }
  const page = await client.list(
    '/api/v1/departments',
    departmentPageSchema,
    { from: String(cursor.departmentFrom), limit: '200', isEnabled: String(cursor.enabled) },
    RUN_SNAPSHOT,
  );
  if (page.data.some((row) => row.isEnabled !== cursor.enabled))
    throw new ConnectorError('invalid-response');
  const checked = checkedPage(
    page.data.map((row) => row.id),
    cursor.departmentBoundary,
    cursor.previousDepartments,
  );
  return {
    id: null,
    next: zohoArchiveScanSchema.parse({
      ...cursor,
      ...emptyTicketPage,
      departmentFrom: cursor.departmentFrom + (page.data.length ? page.data.length - 1 : 0),
      departmentIds: checked.ids,
      departmentOffset: 0,
      departmentsTerminal: page.data.length < 200,
      departmentBoundary: page.data.at(-1)?.id ?? null,
      previousDepartments: checked.fingerprint,
    }),
  };
}

async function ticketPage(
  client: ZohoDeskClient,
  cursor: ArchiveScan,
  departmentId: string,
): Promise<ScanResult> {
  const limit = Math.min(100, 5000 - cursor.from);
  const page = await client.list(
    '/api/v1/tickets/archivedTickets',
    archivePageSchema,
    { departmentId, from: String(cursor.from), limit: String(limit), viewType: '1' },
    RUN_SNAPSHOT,
  );
  if (page.data.length > limit || page.data.some((row) => row.departmentId !== departmentId))
    throw new ConnectorError('invalid-response');
  const checked = checkedPage(
    page.data.map((row) => row.id),
    cursor.boundary,
    cursor.previousPage,
  );
  if (page.data.length === limit && cursor.from + limit >= 5000)
    return client.refuseArchiveWindow(departmentId);
  return {
    id: null,
    next: zohoArchiveScanSchema.parse({
      ...cursor,
      from: cursor.from + (page.data.length ? page.data.length - 1 : 0),
      ids: checked.ids,
      offset: 0,
      terminal: page.data.length < limit,
      boundary: page.data.at(-1)?.id ?? null,
      previousPage: checked.fingerprint,
    }),
  };
}

/** Re-scan every archive in a delta: this resource has no documented modified-time filter. */
export async function readZohoArchiveScan(
  client: ZohoDeskClient,
  cursor: ArchiveScan,
): Promise<ScanResult> {
  if (cursor.departmentOffset > cursor.departmentIds.length || cursor.offset > cursor.ids.length)
    throw new ConnectorError('invalid-response');
  const departmentId = cursor.departmentIds[cursor.departmentOffset];
  if (departmentId === undefined) return departmentPage(client, cursor);
  const id = cursor.ids[cursor.offset];
  if (id !== undefined) return { id, departmentId, next: { ...cursor, offset: cursor.offset + 1 } };
  if (cursor.terminal)
    return {
      id: null,
      next: {
        ...cursor,
        ...emptyTicketPage,
        ids: [],
        departmentOffset: cursor.departmentOffset + 1,
      },
    };
  return ticketPage(client, cursor, departmentId);
}
