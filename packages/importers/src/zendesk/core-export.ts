import type { ImportRecord } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import type { ZendeskClient } from './client.js';
import {
  zendeskCursorEnvelopeSchema,
  zendeskCursorSchema,
  zendeskGroupSchema,
  zendeskListEnvelopeSchema,
  zendeskOffsetSchema,
  zendeskOrganizationSchema,
  zendeskTicketSchema,
  zendeskTimeEnvelopeSchema,
  zendeskUserSchema,
} from './contracts.js';
import {
  zendeskGroupRecord,
  zendeskOrganizationRecord,
  zendeskTicketRecord,
  zendeskUserRecord,
} from './records.js';

function startingCursor(cursor: ImportCursor | null, since: Date | undefined) {
  return zendeskCursorSchema.parse(
    cursor ?? { startTime: since ? Math.max(0, Math.floor(since.getTime() / 1000)) : 0 },
  );
}

export async function* exportZendeskTickets(
  client: ZendeskClient,
  cursor: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let checkpoint = startingCursor(cursor, since);
  const schema = zendeskCursorEnvelopeSchema.extend({
    tickets: z.array(zendeskTicketSchema).max(1000),
  });
  while (true) {
    const page = await client.json('/api/v2/incremental/tickets/cursor.json', schema, {
      per_page: '1000',
      support_type_scope: 'all',
      ...(checkpoint.after === undefined
        ? { start_time: String(checkpoint.startTime) }
        : { cursor: checkpoint.after }),
    });
    const next = { after: page.after_cursor };
    yield {
      records: page.tickets.map((ticket) => zendeskTicketRecord(ticket, client.origin)),
      cursor: page.end_of_stream ? null : next,
      ...(page.end_of_stream ? { deltaCursor: next } : {}),
    };
    if (page.end_of_stream) return;
    checkpoint = next;
  }
}

export async function* exportZendeskUsers(
  client: ZendeskClient,
  cursor: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let checkpoint = startingCursor(cursor, since);
  const schema = zendeskCursorEnvelopeSchema.extend({
    users: z.array(zendeskUserSchema).max(1000),
  });
  while (true) {
    const page = await client.json('/api/v2/incremental/users/cursor.json', schema, {
      per_page: '1000',
      ...(checkpoint.after === undefined
        ? { start_time: String(checkpoint.startTime) }
        : { cursor: checkpoint.after }),
    });
    const next = { after: page.after_cursor };
    yield {
      records: page.users.map(zendeskUserRecord),
      cursor: page.end_of_stream ? null : next,
      ...(page.end_of_stream ? { deltaCursor: next } : {}),
    };
    if (page.end_of_stream) return;
    checkpoint = next;
  }
}

export async function* exportZendeskOrganizations(
  client: ZendeskClient,
  cursor: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let checkpoint = z
    .strictObject({ startTime: z.int().nonnegative() })
    .parse(cursor ?? startingCursor(null, since));
  const schema = zendeskTimeEnvelopeSchema.extend({
    organizations: z.array(zendeskOrganizationSchema).max(1000),
  });
  while (true) {
    const page = await client.json('/api/v2/incremental/organizations.json', schema, {
      start_time: String(checkpoint.startTime),
    });
    const next = { startTime: page.end_time };
    yield {
      records: page.organizations.map(zendeskOrganizationRecord),
      cursor: page.end_of_stream ? null : next,
      ...(page.end_of_stream ? { deltaCursor: next } : {}),
    };
    if (page.end_of_stream) return;
    checkpoint = next;
  }
}

export async function* exportZendeskGroups(
  client: ZendeskClient,
  cursor: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let pageNumber = zendeskOffsetSchema.parse(cursor ?? { page: 1 }).page;
  const path = '/api/v2/groups.json';
  const schema = zendeskListEnvelopeSchema.extend({ groups: z.array(zendeskGroupSchema).max(100) });
  while (true) {
    const page = await client.json(path, schema, { page: String(pageNumber), per_page: '100' });
    const next = client.nextOffset(page.next_page, path, pageNumber);
    const records: ImportRecord[] = page.groups.map(zendeskGroupRecord);
    yield { records, cursor: next === null ? null : { page: next } };
    if (next === null) return;
    pageNumber = next;
  }
}
