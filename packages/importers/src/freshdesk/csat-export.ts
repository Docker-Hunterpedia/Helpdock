import { importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import type { FreshdeskClient } from './client.js';
import { freshdeskRatingSchema } from './contracts.js';

const ratingValues = new Map<number, number>([
  [1, 5],
  [2, 3],
  [3, 1],
  [103, 5],
  [102, 5],
  [101, 5],
  [100, 3],
  [-101, 1],
  [-102, 1],
  [-103, 1],
]);

/** A creation-time filter would miss edited old responses, so deltas rescan ratings. */
export async function* exportFreshdeskLegacyCsat(
  client: FreshdeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let checkpoint = z
    .strictObject({ api: z.literal('legacy'), page: z.number().int().positive().max(1000000) })
    .parse(raw ?? { api: 'legacy', page: 1 });
  let warned = false;
  let warnedUnmapped = false;
  while (true) {
    const response = await client.page(
      '/api/v2/surveys/satisfaction_ratings',
      freshdeskRatingSchema,
      { page: String(checkpoint.page), per_page: '100' },
    );
    const records = response.rows.map((row) => {
      const original = row.ratings.default_question;
      const rating = (original === undefined ? undefined : ratingValues.get(original)) ?? null;
      return importRecordSchema.parse({
        entity: 'csat',
        payload: {
          externalId: `legacy:${row.id}`,
          ticketExternalId: String(row.ticket_id),
          rating,
          ...(row.feedback == null ? {} : { comment: row.feedback }),
          ratedAt: row.created_at,
          sourceDetails: {
            api: 'legacy',
            ...(rating === null
              ? { ratingUnmapped: true }
              : { ratingNormalization: 'sentiment-endpoints' }),
            originalRatings: row.ratings,
            originalAnswers: Object.entries(row.ratings).map(([question_id, value]) => ({
              question_id,
              question_text: question_id,
              value,
            })),
            surveyExternalId: String(row.survey_id),
            responderExternalId: String(row.user_id),
            updatedAt: row.updated_at,
            ...(row.agent_id ? { agentExternalId: String(row.agent_id) } : {}),
            ...(row.group_id ? { groupExternalId: String(row.group_id) } : {}),
          },
        },
      });
    });
    if (
      records.some((record) => record.entity === 'csat' && record.payload.rating !== null) &&
      !warned
    ) {
      await client.warnScaleNormalization();
      warned = true;
    }
    if (
      records.some((record) => record.entity === 'csat' && record.payload.rating === null) &&
      !warnedUnmapped
    ) {
      await client.warnUnmappedRating();
      warnedUnmapped = true;
    }
    const next =
      response.nextPage === null ? null : { api: 'legacy' as const, page: response.nextPage };
    yield { records, cursor: next };
    if (!next) return;
    checkpoint = next;
  }
}
