import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { ZendeskClient } from './client.js';
import type { ThreadCursor } from './threads-export.js';

const eventSchema = z
  .record(z.string(), z.json())
  .and(z.object({ id: z.int().positive(), type: z.string().min(1) }));
const auditSchema = z.looseObject({
  id: z.int().positive(),
  ticket_id: z.int().positive(),
  author_id: z.int().nullable().optional(),
  created_at: z.iso.datetime({ offset: true }),
  events: z.array(eventSchema).max(1000),
  via: z.record(z.string(), z.json()).optional(),
  metadata: z.record(z.string(), z.json()).optional(),
});
const auditPageSchema = z.object({
  // Archived audits are unpaginated and may exceed the usual 100-record page.
  audits: z.array(auditSchema).max(100000),
  next_page: z.url().nullable(),
});

async function auditRecords(
  client: ZendeskClient,
  audit: z.infer<typeof auditSchema>,
): Promise<ImportRecord[]> {
  const events = audit.events.filter((event) => !['Comment', 'VoiceComment'].includes(event.type));
  if (!events.length) return [];
  const authorKind =
    audit.author_id != null && audit.author_id > 0
      ? await client.authorKind(audit.author_id)
      : 'system';
  return events.map((event) =>
    importRecordSchema.parse({
      entity: 'activity',
      payload: {
        externalId: `${audit.id}:${event.id}`,
        ticketExternalId: String(audit.ticket_id),
        authorKind,
        ...(authorKind === 'system' ? {} : { authorExternalId: String(audit.author_id) }),
        action: `zendesk.${event.type}`,
        createdAt: audit.created_at,
        ...(event.previous_value === undefined
          ? {}
          : { from: { field: event.field_name ?? null, value: event.previous_value } }),
        ...(event.value === undefined
          ? {}
          : { to: { field: event.field_name ?? null, value: event.value } }),
        details: {
          auditId: String(audit.id),
          event,
          ...(audit.via ? { via: audit.via } : {}),
          ...(audit.metadata ? { metadata: audit.metadata } : {}),
        },
      },
    }),
  );
}

export async function* ticketAudits(
  client: ZendeskClient,
  state: ThreadCursor,
  ticketId: number,
): AsyncGenerator<ImportPage> {
  const path = `/api/v2/tickets/${ticketId}/audits.json`;
  let checkpoint = state.audit ?? { page: 1, offset: 0 };
  while (true) {
    const response = await client.ticketJson(ticketId, path, auditPageSchema, {
      page: String(checkpoint.page),
      per_page: '100',
      sort_order: 'asc',
    });
    if (!response) return;
    const fingerprint = hashImportValue(response.audits);
    if (
      (checkpoint.fingerprint && checkpoint.fingerprint !== fingerprint) ||
      checkpoint.offset > response.audits.length
    )
      throw new ConnectorError('invalid-response');
    for (let index = checkpoint.offset; index < response.audits.length; index++) {
      const audit = response.audits[index];
      if (!audit || audit.ticket_id !== ticketId) throw new ConnectorError('invalid-response');
      yield {
        records: await auditRecords(client, audit),
        cursor: z
          .record(z.string(), z.json())
          .parse({ ...state, audit: { page: checkpoint.page, offset: index + 1, fingerprint } }),
      };
    }
    const next = client.nextOffset(response.next_page, path, checkpoint.page);
    if (next === null) return;
    checkpoint = { page: next, offset: 0 };
    yield {
      records: [],
      cursor: z.record(z.string(), z.json()).parse({ ...state, audit: checkpoint }),
    };
  }
}
