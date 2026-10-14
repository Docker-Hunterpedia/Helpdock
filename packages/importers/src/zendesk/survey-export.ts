import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { ZendeskClient } from './client.js';

const answerSchema = z.object({
  type: z.enum(['skipped', 'closed_ended', 'open_ended', 'rating_scale']),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  question: z
    .record(z.string(), z.json())
    .and(z.object({ id: z.string().min(1), type: z.string(), sub_type: z.string().optional() })),
  rating: z.int().optional(),
  rating_category: z.enum(['bad', 'neutral', 'good']).optional(),
  value: z.string().optional(),
  selections: z.array(z.record(z.string(), z.json())).optional(),
});
const surveySchema = z.object({
  id: z.string().min(1),
  responder_id: z.int().positive(),
  subjects: z
    .array(z.object({ id: z.string().min(1), type: z.string(), zrn: z.string() }))
    .max(100),
  answers: z.array(answerSchema).max(100),
  survey: z.object({ id: z.string(), version: z.int(), state: z.string() }),
});
const pageSchema = z.object({
  meta: z.object({ has_more: z.boolean(), after_cursor: z.string().nullable().optional() }),
  survey_responses: z.array(surveySchema).max(100),
});

function surveyRecords(survey: z.infer<typeof surveySchema>): ImportRecord[] {
  const ticketSubjects = survey.subjects.filter((subject) => subject.type === 'ticket');
  if (!ticketSubjects.length) return [];
  if (ticketSubjects.length !== 1) throw new ConnectorError('invalid-response');
  const ticket = ticketSubjects[0];
  if (!ticket || ticket.zrn !== `zen:ticket:${ticket.id}`)
    throw new ConnectorError('invalid-response');
  const answers = survey.answers.filter(
    (answer) =>
      answer.type === 'rating_scale' && answer.question.sub_type === 'customer_satisfaction',
  );
  const comments = survey.answers
    .filter((answer) => answer.type === 'open_ended')
    .map((answer) => {
      if (answer.value === undefined) throw new ConnectorError('invalid-response');
      return answer.value;
    });
  return answers.map((answer) => {
    if (answer.rating === undefined || answer.rating_category === undefined)
      throw new ConnectorError('invalid-response');
    return importRecordSchema.parse({
      entity: 'csat',
      payload: {
        externalId: `survey:${survey.id}:${answer.question.id}`,
        ticketExternalId: ticket.id,
        rating: { bad: 1, neutral: 3, good: 5 }[answer.rating_category],
        ...(comments.length ? { comment: comments.join('\n\n') } : {}),
        ratedAt: answer.created_at,
        sourceDetails: {
          api: 'survey',
          originalRating: answer.rating,
          ratingNormalization: 'category-endpoints',
          ratingCategory: answer.rating_category,
          ratedAtBasis: 'answer-created-at',
          updatedAt: answer.updated_at,
          responderExternalId: String(survey.responder_id),
          survey: survey.survey,
          answers: survey.answers,
        },
      },
    });
  });
}

export async function* exportZendeskSurveys(
  client: ZendeskClient,
  cursor: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let checkpoint = z.strictObject({ after: z.string().min(1).optional() }).parse(cursor ?? {});
  let scaleWarningLogged = false;
  // Creation-time filters cannot catch edits to old answers. A delta rescans every response.
  while (true) {
    const response = await client.json('/api/v2/guide/survey_responses', pageSchema, {
      'page[size]': '100',
      ...(checkpoint.after ? { 'page[after]': checkpoint.after } : {}),
      sort: 'id',
    });
    const records = response.survey_responses.flatMap(surveyRecords);
    if (records.length && !scaleWarningLogged) {
      await client.warnSurveyScaleNormalization();
      scaleWarningLogged = true;
    }
    const after = response.meta.after_cursor;
    if (!response.meta.has_more) {
      yield { records, cursor: null };
      return;
    }
    if (!after || after === checkpoint.after) throw new ConnectorError('invalid-response');
    yield { records, cursor: { after } };
    checkpoint = { after };
  }
}
