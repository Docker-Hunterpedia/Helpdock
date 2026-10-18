import { importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import {
  advanceImportTokenCycle,
  importTokenCycleSchema,
  initialImportTokenCycle,
} from '../pagination-token.js';
import type { FreshdeskClient } from './client.js';
import { freshdeskSurveyResponseSchema, freshdeskSurveySchema } from './contracts.js';

const token = z.string().min(1).max(4096).nullable();
const cursorSchema = z.strictObject({
  api: z.literal('modern'),
  surveyToken: token,
  surveyOffset: z.number().int().min(0).max(99),
  surveyFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  responseToken: token,
  surveyCycle: importTokenCycleSchema,
  responseCycle: importTokenCycleSchema,
  pages: z.number().int().nonnegative().max(1000000),
});

/** Re-read old answers on delta: the documented filter selects creation, not changes. */
export async function* exportFreshdeskModernCsat(
  client: FreshdeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let checkpoint = cursorSchema.parse(
    raw ?? {
      api: 'modern',
      surveyToken: null,
      surveyOffset: 0,
      surveyFingerprint: null,
      responseToken: null,
      pages: 0,
      surveyCycle: initialImportTokenCycle(),
      responseCycle: initialImportTokenCycle(),
    },
  );
  let warned = false;
  while (true) {
    if (checkpoint.pages >= 1000000) throw new ConnectorError('invalid-response');
    const surveys = await client.tokenPage(
      '/api/v2/customer-satisfaction/surveys',
      freshdeskSurveySchema,
      checkpoint.surveyToken,
    );
    const fingerprint = hashImportValue(surveys.rows.map((row) => row.id));
    if (checkpoint.surveyFingerprint !== null && checkpoint.surveyFingerprint !== fingerprint)
      throw new ConnectorError('invalid-response');
    const survey = surveys.rows[checkpoint.surveyOffset];
    if (!survey) {
      if (checkpoint.surveyOffset !== 0 || checkpoint.responseToken !== null)
        throw new ConnectorError('invalid-response');
      yield { records: [], cursor: null };
      return;
    }
    const response = await client.tokenPage(
      `/api/v2/customer-satisfaction/surveys/${survey.id}/responses`,
      freshdeskSurveyResponseSchema,
      checkpoint.responseToken,
    );
    const records = response.rows.map((row) => {
      if (row.survey_id !== survey.id || Date.parse(row.updated_at) < Date.parse(row.created_at))
        throw new ConnectorError('invalid-response');
      return importRecordSchema.parse({
        entity: 'csat',
        payload: {
          externalId: `modern:${survey.id}:${row.id}`,
          ticketExternalId: String(row.ticket_id),
          rating: null,
          ratedAt: row.created_at,
          sourceDetails: {
            api: 'modern',
            ratingUnmapped: true,
            surveyExternalId: survey.id,
            surveyTitle: survey.title,
            surveyVersionId: row.survey_version_id,
            responseExternalId: row.id,
            responderExternalId: row.user_id,
            agentExternalId: row.agent_id,
            groupExternalId: row.group_id,
            responseStatus: row.status,
            originalAnswers: row.answers,
            updatedAt: row.updated_at,
          },
        },
      });
    });
    if (records.length && !warned) {
      await client.warnUnmappedRating();
      warned = true;
    }
    let next: z.infer<typeof cursorSchema> | null;
    if (response.nextToken !== null)
      next = {
        ...checkpoint,
        surveyFingerprint: fingerprint,
        responseToken: response.nextToken,
        responseCycle: advanceImportTokenCycle(checkpoint.responseCycle, response.nextToken),
        pages: checkpoint.pages + 1,
      };
    else if (checkpoint.surveyOffset + 1 < surveys.rows.length)
      next = {
        ...checkpoint,
        surveyFingerprint: fingerprint,
        surveyOffset: checkpoint.surveyOffset + 1,
        responseToken: null,
        responseCycle: initialImportTokenCycle(),
        pages: checkpoint.pages + 1,
      };
    else
      next =
        surveys.nextToken === null
          ? null
          : {
              ...checkpoint,
              surveyToken: surveys.nextToken,
              surveyOffset: 0,
              surveyFingerprint: null,
              responseToken: null,
              surveyCycle: advanceImportTokenCycle(checkpoint.surveyCycle, surveys.nextToken),
              responseCycle: initialImportTokenCycle(),
              pages: checkpoint.pages + 1,
            };
    yield { records, cursor: next };
    if (next === null) return;
    checkpoint = next;
  }
}
