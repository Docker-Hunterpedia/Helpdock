import { describe, expect, it } from 'vitest';
import {
  CSAT_BRAND,
  CSAT_NOW,
  CSAT_SURVEY,
  CSAT_TICKET,
  csatSurveyRow,
} from '../testing/csat-doubles.js';
import { recordingTx } from '../testing/email-doubles.js';
import type { CsatAnswer, CsatRepository } from './csat.repository.js';
import { recordCsatAnswer } from './csat-answers.js';
import { CSAT_EVENTS } from './csat-events.js';

const answer: CsatAnswer = { rating: 4, comment: 'Quick.', via: 'widget', at: CSAT_NOW };

const record = (taken: boolean) => {
  const recording = recordingTx();
  const repository: Pick<CsatRepository, 'rate'> = {
    rate: (_tx, _id, given) =>
      Promise.resolve(
        taken
          ? csatSurveyRow({ rating: given.rating, comment: given.comment, ratedAt: given.at })
          : undefined,
      ),
  };

  return {
    ...recording,
    result: recordCsatAnswer(recording.tx, repository, {
      brandId: CSAT_BRAND,
      surveyId: CSAT_SURVEY,
      answer,
    }),
  };
};

describe('recordCsatAnswer', () => {
  it('audits the answer and emits csat.received with the ticket and the channel', async () => {
    const { result, audit, outbox } = record(true);

    expect(await result).toMatchObject({ rating: 4 });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'csat.rated',
        actorType: 'system',
        actorId: `csat:${CSAT_SURVEY}`,
        targetId: CSAT_TICKET,
        meta: { rating: 4, via: 'widget' },
      }),
    ]);
    expect(outbox).toEqual([
      {
        event: CSAT_EVENTS.received,
        payload: {
          ticketId: CSAT_TICKET,
          surveyId: CSAT_SURVEY,
          rating: 4,
          via: 'widget',
          ratedAt: CSAT_NOW.toISOString(),
        },
      },
    ]);
  });

  it('writes nothing when the survey no longer takes an answer', async () => {
    const { result, audit, outbox } = record(false);

    expect(await result).toBeUndefined();
    expect(audit).toEqual([]);
    expect(outbox).toEqual([]);
  });
});
