import type { DbTransaction } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import {
  enqueueOutbox,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import {
  CSAT_TOKEN_TTL_DAYS,
  csatAnswerChannelSchema,
  csatRatingSchema,
  isSpamStatus,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { CsatRepository } from './csat.repository.js';
import type { CsatDelivery } from './csat-delivery.js';
import { type CsatTokens, hashCsatToken } from './tokens.js';

/**
 * How a close becomes a survey (DOMAIN-RULES §2.2: "CSAT scheduled (if enabled,
 * not spam, not merged)"), by the route §6 allows:
 *
 * ```
 * close   →  tickets + ticket_activity + outbox(csat.requested)   (one transaction)
 * relay   →  BullMQ outbox.event                                   (after commit)
 * worker  →  this handler → csat_responses + the channel's send    (with its receipt)
 * answer  →  csat_responses + outbox(csat.received)                (page, widget or Telegram)
 * ```
 *
 * The event is its own rather than a second handler on `ticket.closed`, because
 * `ticket.closed` fires for every close — spam and merge included — and the
 * decision that a close deserves a survey is made once, by the lifecycle, in the
 * transaction that closed it (`tickets/lifecycle/hooks.ts`). The brand toggle is
 * read there too, so a survey reflects the setting at the moment of the close.
 *
 * The survey goes out on the ticket's channel in the same transaction
 * (`csat-delivery.ts`, M8-06). Every recorded answer emits `csat.received`
 * (`csat-answers.ts`), which workflow rules subscribe to (M3-03) and which is
 * the webhook event of the same name.
 */

export const CSAT_EVENTS = {
  requested: 'csat.requested',
  received: 'csat.received',
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

/**
 * An answer was recorded. `ticketId` is what the rules module reads of any
 * event; the comment is not carried, so the outbox holds no customer text.
 */
export const csatReceivedPayloadSchema = z.object({
  ticketId: z.uuid(),
  surveyId: z.uuid(),
  rating: csatRatingSchema,
  via: csatAnswerChannelSchema,
  ratedAt: z.iso.datetime(),
});
export type CsatReceivedPayload = z.infer<typeof csatReceivedPayloadSchema>;

export const enqueueCsatReceived = (
  tx: DbTransaction,
  brandId: string,
  payload: CsatReceivedPayload,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: CSAT_EVENTS.received,
    payload: csatReceivedPayloadSchema.parse(payload),
  });

const DAY_MS = 86_400_000;

export interface CsatSurveyJobDependencies {
  readonly repository: CsatRepository;
  readonly tokens: CsatTokens;
  readonly delivery: Pick<CsatDelivery, 'deliver'>;
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
 * even past the job receipt, and only the run that created the survey sends it.
 */
export const createCsatRequestedHandler =
  ({
    repository,
    tokens,
    delivery,
    now = () => new Date(),
  }: CsatSurveyJobDependencies): OutboxEventHandler =>
  async ({ brandId, payload, tx, log }: OutboxEventContext): Promise<void> => {
    const { ticketId, closedAt } = csatRequestedPayloadSchema.parse(payload);
    const facts = await repository.closedTicketFacts(tx, ticketId);

    const stillThatClose =
      facts !== undefined &&
      facts.deletedAt === null &&
      facts.mergedIntoId === null &&
      !isSpamStatus(facts) &&
      facts.closedAt?.toISOString() === closedAt;

    if (!stillThatClose) {
      log.info({ brandId, ticketId, closedAt }, 'csat survey skipped: the close no longer stands');
      return;
    }

    const id = uuidv7();
    const created = now();
    const survey = await repository.insertSurvey(tx, {
      id,
      brandId,
      ticketId,
      departmentId: facts.departmentId,
      closedAt: new Date(closedAt),
      tokenHash: hashCsatToken(tokens.sign({ brandId, surveyId: id })),
      expiresAt: new Date(created.getTime() + CSAT_TOKEN_TTL_DAYS * DAY_MS),
    });
    if (survey === undefined) {
      log.info({ brandId, ticketId }, 'csat survey already exists for this close');
      return;
    }

    const channel = await delivery.deliver(
      tx,
      brandId,
      { id: ticketId, ...facts },
      survey,
      created,
    );
    log.info({ brandId, ticketId, surveyId: id, channel }, 'csat survey created');
  };

/**
 * `csat.received`'s own slot. Rules (M3-03) and webhooks (M8-03) subscribe to
 * the event under their names; this only leaves the answer in the log.
 */
const logCsatReceived: OutboxEventHandler = async ({ brandId, payload, log }) => {
  const { ticketId, rating, via } = csatReceivedPayloadSchema.parse(payload);
  log.info({ brandId, ticketId, rating, via }, 'csat answer received');
  await Promise.resolve();
};

/** Called by the worker's start-up, before the consumer exists (`worker/start-worker.ts`). */
export const registerCsatEventHandlers = (dependencies: CsatSurveyJobDependencies): void => {
  registerEventHandler(CSAT_EVENTS.requested, createCsatRequestedHandler(dependencies));
  registerEventHandler(CSAT_EVENTS.received, logCsatReceived);
};
