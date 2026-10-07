import { auditLog, type CsatResponse, type DbTransaction } from '@helpdock/db';
import type { CsatAnswer, CsatRepository } from './csat.repository.js';
import { enqueueCsatReceived } from './csat-events.js';

/**
 * One answer recorded, from any channel (M8-06): the rating page a link opens,
 * the widget's card, or a Telegram button.
 *
 * Every recorded answer writes, in the caller's transaction, the `audit_log`
 * row of the survey's system principal `csat:<surveyId>` — none of the three
 * callers has a staff member behind it — and the `csat.received` outbox event
 * that workflow rules and webhooks act on. An answer the survey no longer takes
 * (answered, expired) writes neither and answers undefined.
 */
export const recordCsatAnswer = async (
  tx: DbTransaction,
  repository: Pick<CsatRepository, 'rate'>,
  { brandId, surveyId, answer }: { brandId: string; surveyId: string; answer: CsatAnswer },
): Promise<CsatResponse | undefined> => {
  const rated = await repository.rate(tx, surveyId, answer);
  if (rated === undefined) {
    return undefined;
  }

  await tx.insert(auditLog).values({
    brandId,
    actorType: 'system',
    actorId: `csat:${surveyId}`,
    action: 'csat.rated',
    targetType: 'ticket',
    targetId: rated.ticketId,
    meta: { rating: answer.rating, via: answer.via },
  });
  await enqueueCsatReceived(tx, brandId, {
    ticketId: rated.ticketId,
    surveyId,
    rating: answer.rating,
    via: answer.via,
    ratedAt: answer.at.toISOString(),
  });

  return rated;
};
