import { importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';

const instant = z.iso.datetime({ offset: true });
const reference = z.string().min(1).max(200).nullable().optional();
const answerSchema = z.object({
  id: zohoIdSchema,
  ticketId: zohoIdSchema,
  threadId: zohoIdSchema,
  rating: z.string().min(1).max(100),
  feedback: z
    .string()
    .max(2 * 1024 * 1024)
    .nullable()
    .optional(),
  ratedTime: instant,
  customerRatedTime: instant.nullable().optional(),
  timezoneOffset: z.string().max(100).nullable().optional(),
  agentId: reference,
  contactId: reference,
  accountId: reference,
  departmentId: reference,
});
const cursorSchema = z.strictObject({
  endTime: z.int().nonnegative().safe(),
  from: z.int().min(0).max(2147483647),
  offset: z.int().min(0).max(50),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
const ratings = new Map([
  ['GOOD', 5],
  ['OKAY', 3],
  ['OK', 3],
  ['BAD', 1],
]);

async function csatRecord(client: ZohoDeskClient, answer: z.infer<typeof answerSchema>) {
  const full = await client.json(
    `/api/v1/customerHappiness/${answer.threadId}/content`,
    z.object({ content: z.string().max(2 * 1024 * 1024) }),
  );
  const rating = ratings.get(answer.rating) ?? null;
  if (rating === null) await client.warnCsat('import.csat.rating-unmapped', answer.id);
  return importRecordSchema.parse({
    entity: 'csat',
    payload: {
      externalId: answer.id,
      ticketExternalId: answer.ticketId,
      rating,
      comment: full.content,
      ratedAt: answer.customerRatedTime ?? answer.ratedTime,
      sourceDetails: {
        originalRating: answer.rating,
        ...(rating === null
          ? { ratingUnmapped: true }
          : { ratingNormalization: 'sentiment-endpoints' }),
        ratedAtBasis: answer.customerRatedTime == null ? 'ratedTime' : 'customerRatedTime',
        ratedTime: answer.ratedTime,
        customerRatedTime: answer.customerRatedTime ?? null,
        timezoneOffset: answer.timezoneOffset ?? null,
        listFeedback: answer.feedback ?? null,
        threadExternalId: answer.threadId,
        agentExternalId: answer.agentId ?? null,
        contactExternalId: answer.contactId ?? null,
        accountExternalId: answer.accountId ?? null,
        departmentExternalId: answer.departmentId ?? null,
      },
    },
  });
}

/** Rescan on deltas: rating-time filters do not find edited old answers. */
export async function* exportZohoCsat(
  client: ZohoDeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let cursor = cursorSchema.parse(
    raw ?? { endTime: Date.now(), from: 0, offset: 0, fingerprint: null },
  );
  if (raw === null) yield { records: [], cursor };
  let warned = false;
  while (true) {
    const page = await client.list(
      '/api/v1/customerHappiness',
      z.object({ data: z.array(answerSchema).max(50) }),
      {
        department: 'allDepartment',
        from: String(cursor.from),
        limit: '50',
        sortBy: 'ratedtime',
        startTime: '0',
        endTime: String(cursor.endTime),
      },
    );
    const fingerprint = hashImportValue(page.data);
    if (
      new Set(page.data.map((answer) => answer.id)).size !== page.data.length ||
      cursor.offset > page.data.length ||
      (cursor.fingerprint !== null && cursor.fingerprint !== fingerprint)
    )
      throw new ConnectorError('invalid-response');
    while (cursor.offset < page.data.length) {
      const answer = page.data[cursor.offset];
      if (!answer) throw new ConnectorError('invalid-response');
      if (!warned) {
        // The official example exposes two differing Z-labelled times and a
        // timezone offset. Keep both verbatim; do not invent a second conversion.
        await client.warnCsat('import.csat.timestamp-inferred');
        await client.warnCsat('import.csat.scale-normalized');
        warned = true;
      }
      const record = await csatRecord(client, answer);
      cursor = { ...cursor, offset: cursor.offset + 1, fingerprint };
      yield { records: [record], cursor };
    }
    if (page.data.length < 50) {
      yield { records: [], cursor: null };
      return;
    }
    cursor = cursorSchema.parse({
      ...cursor,
      from: cursor.from + page.data.length,
      offset: 0,
      fingerprint: null,
    });
    yield { records: [], cursor };
  }
}
