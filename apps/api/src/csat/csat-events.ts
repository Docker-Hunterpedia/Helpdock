import type { DbTransaction } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import {
  enqueueOutbox,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import { CSAT_TOKEN_TTL_DAYS } from '@helpdock/schemas';
import { z } from 'zod';
import type { CsatRepository } from './csat.repository.js';
import { type CsatTokens, hashCsatToken } from './tokens.js';

/**
 * How a close becomes a survey (DOMAIN-RULES §2.2: "CSAT scheduled (if enabled,
 * not spam, not merged)"), by the route §6 allows:
 *
 * ```
 * close   →  tickets + ticket_activity + outbox(csat.requested)   (one transaction)
 * relay   →  BullMQ outbox.event                                   (after commit)
 * worker  →  this handler → csat_responses                         (with its receipt)
 * ```
 *
 * The event is its own rather than a second handler on `ticket.closed`, because
 * `ticket.closed` fires for every close — spam and merge included — and the
 * decision that a close deserves a survey is made once, by the lifecycle, in the
 * transaction that closed it (`tickets/lifecycle/hooks.ts`). The brand toggle is
 * read there too, so a survey reflects the setting at the moment of the close.
 *
 * Delivering the link is per channel and later (M8-06). Until then the agent
 * shares it from the details panel.
 */

export const CSAT_EVENTS = {
  requested: 'csat.requested',
} as const;

export const csatRequestedPayloadSchema = z.object({
  ticketId: z.uuid(),
  /** The close the survey is for. A later close is a later survey. */
  closedAt: z.iso.datetime(),
});
export type CsatRequestedPayload = z.infer<typeof csatRequestedPayloadSchema>;

export const enqueueCsatRequested = (
  tx: DbTransaction,
  brandId: string,
  payload: CsatRequestedPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: CSAT_EVENTS.requested,
    payload: csatRequestedPayloadSchema.parse(payload),
  });

const DAY_MS = 86_400_000;

export interface CsatSurveyJobDependencies {
  readonly repository: CsatRepository;
  readonly tokens: CsatTokens;
  /** Overridden by tests. */
  readonly now?: () => Date;
}

/**
 * Creates the survey, idempotently.
 *
 * The job re-reads the ticket rather than trusting the payload, because time
 * passed between the close and this: a ticket reopened (or deleted, merged or
 * marked spam) since is no longer the close the survey would ask about, and is
 * skipped. The unique `(ticket_id, closed_at)` makes a second delivery a no-op
 * even past the job receipt.
 */
export const createCsatRequestedHandler =
  ({ repository, tokens, now = () => new Date() }: CsatSurveyJobDependencies): OutboxEventHandler =>
  async ({ brandId, payload, tx, log }: OutboxEventContext): Promise<void> => {
    const { ticketId, closedAt } = csatRequestedPayloadSchema.parse(payload);
    const facts = await repository.closedTicketFacts(tx, ticketId);

    const stillThatClose =
      facts !== undefined &&
      facts.deletedAt === null &&
      facts.mergedIntoId === null &&
      !facts.excludedFromReports &&
      facts.closedAt?.toISOString() === closedAt;

    if (!stillThatClose) {
      log.info({ brandId, ticketId, closedAt }, 'csat survey skipped: the close no longer stands');
      return;
    }

    const id = uuidv7();
    const created = now();
    const inserted = await repository.insertSurvey(tx, {
      id,
      brandId,
      ticketId,
      departmentId: facts.departmentId,
      closedAt: new Date(closedAt),
      tokenHash: hashCsatToken(tokens.sign({ brandId, surveyId: id })),
      expiresAt: new Date(created.getTime() + CSAT_TOKEN_TTL_DAYS * DAY_MS),
    });

    log.info({ brandId, ticketId, surveyId: inserted ? id : null }, 'csat survey created');
  };

/** Called by the worker's start-up, before the consumer exists (`worker/start-worker.ts`). */
export const registerCsatEventHandlers = (dependencies: CsatSurveyJobDependencies): void => {
  registerEventHandler(CSAT_EVENTS.requested, createCsatRequestedHandler(dependencies));
};
