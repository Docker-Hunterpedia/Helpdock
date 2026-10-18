import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import type { ZendeskClient } from './client.js';
import { zendeskListEnvelopeSchema, zendeskOffsetSchema } from './contracts.js';
import { exportZendeskSurveys } from './survey-export.js';

const ratingSchema = z.looseObject({
  id: z.int().positive(),
  ticket_id: z.int().positive(),
  score: z.enum(['good', 'bad', 'offered', 'unoffered']),
  comment: z.string().nullish(),
  reason: z.string().nullish(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  assignee_id: z.int().nullable().optional(),
  group_id: z.int().nullable().optional(),
  requester_id: z.int().nullable().optional(),
});

function ratingRecord(rating: z.infer<typeof ratingSchema>): ImportRecord[] {
  if (rating.score === 'offered' || rating.score === 'unoffered') return [];
  return [
    importRecordSchema.parse({
      entity: 'csat',
      payload: {
        externalId: `legacy:${rating.id}`,
        ticketExternalId: String(rating.ticket_id),
        rating: rating.score === 'good' ? 5 : 1,
        ...(rating.comment == null ? {} : { comment: rating.comment }),
        ratedAt: rating.created_at,
        sourceDetails: {
          api: 'legacy',
          score: rating.score,
          scale: ['bad', 'good'],
          createdAt: rating.created_at,
          updatedAt: rating.updated_at,
          ratedAtBasis: 'source-created-at',
          reason: rating.reason ?? null,
          assigneeExternalId: rating.assignee_id == null ? null : String(rating.assignee_id),
          groupExternalId: rating.group_id == null ? null : String(rating.group_id),
          requesterExternalId: rating.requester_id == null ? null : String(rating.requester_id),
        },
      },
    }),
  ];
}

async function* exportZendeskLegacyCsat(
  client: ZendeskClient,
  cursor: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let checkpoint = zendeskOffsetSchema.parse(cursor ?? { page: 1 });
  let timestampWarningLogged = false;
  const path = '/api/v2/satisfaction_ratings.json';
  const schema = zendeskListEnvelopeSchema.extend({
    satisfaction_ratings: z.array(ratingSchema).max(100),
  });
  // The filters describe rating time, not a changed-since contract. Rescan for edits on delta.
  while (true) {
    const response = await client.json(path, schema, {
      page: String(checkpoint.page),
      per_page: '100',
    });
    const next = client.nextOffset(response.next_page, path, checkpoint.page);
    const records = response.satisfaction_ratings.flatMap(ratingRecord);
    if (records.length && !timestampWarningLogged) {
      await client.warnLegacyCsatTimestamp();
      timestampWarningLogged = true;
    }
    yield {
      records,
      cursor: next === null ? null : { page: next },
    };
    if (next === null) return;
    checkpoint = { page: next };
  }
}

export async function* exportZendeskCsat(
  client: ZendeskClient,
  cursor: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  const checkpoint = z
    .discriminatedUnion('phase', [
      zendeskOffsetSchema.extend({ phase: z.literal('legacy') }),
      z.strictObject({ phase: z.literal('survey'), after: z.string().optional() }),
    ])
    .parse(cursor ?? { phase: 'legacy', page: 1 });
  if (checkpoint.phase === 'legacy') {
    for await (const page of exportZendeskLegacyCsat(client, { page: checkpoint.page })) {
      yield {
        records: page.records,
        cursor: page.cursor ? { ...page.cursor, phase: 'legacy' } : { phase: 'survey' },
      };
    }
  }
  const after = checkpoint.phase === 'survey' ? checkpoint.after : undefined;
  for await (const page of exportZendeskSurveys(client, after ? { after } : null)) {
    yield {
      records: page.records,
      cursor: page.cursor ? { ...page.cursor, phase: 'survey' } : null,
    };
  }
}
