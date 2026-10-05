import type { CsatResponse } from '@helpdock/db';
import {
  WIDGET_EVENTS,
  type WidgetCsat,
  type WidgetCsatRequest,
  type WidgetCsatResponse,
} from '@helpdock/schemas';
import type { CsatRepository } from '../csat/csat.repository.js';
import { recordCsatAnswer } from '../csat/csat-answers.js';
import type { WidgetConversationsService } from './widget-conversations.service.js';
import type { VisitorScope, WidgetGate, WidgetRequestFacts } from './widget-gate.js';
import { conversationRoom, type WidgetBroadcast } from './widget-relay.js';

/**
 * The widget's satisfaction card (M8-06, `Widget/CSAT-EN`): read, answer or
 * skip the survey of a closed widget conversation's latest close.
 *
 * Every change is told to the conversation's room after it commits, so the
 * card a visitor answered on one device is not offered on another. An answer
 * goes through the same recorder as the rating page and Telegram
 * (`csat/csat-answers.ts`), so it writes `csat.received` like theirs.
 */

/** The card for a survey: an answer wins, then Skip, then the thirty days. */
export const widgetCsatOf = (
  conversationId: string,
  survey: CsatResponse,
  now: Date,
): WidgetCsat => ({
  conversationId,
  state:
    survey.ratedAt !== null
      ? 'rated'
      : survey.expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : survey.skippedAt !== null
          ? 'skipped'
          : 'open',
  rating: survey.rating,
  comment: survey.comment,
  skippedAt: survey.skippedAt?.toISOString() ?? null,
});

export class WidgetCsatService {
  readonly #gate: WidgetGate;
  readonly #conversations: Pick<WidgetConversationsService, 'require'>;
  readonly #repository: Pick<CsatRepository, 'latestForTicket' | 'rate' | 'skip'>;
  readonly #broadcast: WidgetBroadcast;
  readonly #now: () => Date;

  constructor(deps: {
    readonly gate: WidgetGate;
    readonly conversations: Pick<WidgetConversationsService, 'require'>;
    readonly repository: Pick<CsatRepository, 'latestForTicket' | 'rate' | 'skip'>;
    readonly broadcast: WidgetBroadcast;
    readonly now?: () => Date;
  }) {
    this.#gate = deps.gate;
    this.#conversations = deps.conversations;
    this.#repository = deps.repository;
    this.#broadcast = deps.broadcast;
    this.#now = deps.now ?? (() => new Date());
  }

  async card(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
  ): Promise<WidgetCsatResponse> {
    return this.#gate.visitor(brandId, facts, { write: false }, async (scope) => {
      const found = await this.#survey(scope, conversationId);

      return {
        csat: found === undefined ? null : widgetCsatOf(conversationId, found, this.#now()),
      };
    });
  }

  /** Records the rating once; a card already answered, skipped past or expired answers as it is. */
  async rate(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    request: WidgetCsatRequest,
  ): Promise<WidgetCsatResponse> {
    return this.#change(brandId, facts, conversationId, async (scope, survey) => {
      const at = this.#now();
      const rated = await recordCsatAnswer(scope.tx, this.#repository, {
        brandId,
        surveyId: survey.id,
        answer: { rating: request.rating, comment: request.comment || null, via: 'widget', at },
      });

      return rated ?? survey;
    });
  }

  /** Skip records no answer; it only stops the card being offered again. */
  async skip(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
  ): Promise<WidgetCsatResponse> {
    return this.#change(brandId, facts, conversationId, async (scope, survey) => {
      const at = this.#now();
      const skipped = await this.#repository.skip(scope.tx, survey.id, at);

      return skipped ? { ...survey, skippedAt: at } : survey;
    });
  }

  async #change(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    apply: (scope: VisitorScope, survey: CsatResponse) => Promise<CsatResponse>,
  ): Promise<WidgetCsatResponse> {
    const csat = await this.#gate.visitor(brandId, facts, { write: true }, async (scope) => {
      const survey = await this.#survey(scope, conversationId);
      return survey === undefined
        ? null
        : widgetCsatOf(conversationId, await apply(scope, survey), this.#now());
    });
    if (csat !== null) {
      await this.#broadcast.emit({
        room: conversationRoom(conversationId),
        event: WIDGET_EVENTS.csat,
        data: csat,
        seq: null,
      });
    }

    return { csat };
  }

  /**
   * The survey of the close the conversation is in, if it is a widget
   * conversation and closed. A reopened conversation has no card: its last
   * survey was for a close that no longer stands.
   */
  async #survey(scope: VisitorScope, conversationId: string): Promise<CsatResponse | undefined> {
    const { ticket } = await this.#conversations.require(scope, conversationId);
    if (ticket.channel !== 'chat' || ticket.closedAt === null) {
      return undefined;
    }
    const survey = await this.#repository.latestForTicket(scope.tx, ticket.id);

    return survey?.closedAt.getTime() === ticket.closedAt.getTime() ? survey : undefined;
  }
}
