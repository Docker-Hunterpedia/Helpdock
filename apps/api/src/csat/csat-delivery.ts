import type { CsatResponse, DbTransaction } from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import { WIDGET_EVENTS } from '@helpdock/schemas';
import type { OutboundEmailService } from '../email/outbound-email.service.js';
import type { TelegramRepository } from '../telegram/telegram.repository.js';
import { enqueueTelegramNotice } from '../telegram/telegram-events.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { conversationRoom, type WidgetBroadcast } from '../widget/widget-relay.js';
import type { ClosedTicketFacts, CsatRepository } from './csat.repository.js';

/**
 * M8-06: a new survey, sent on the channel the ticket came in on, inside the
 * survey job's transaction (`csat-events.ts`).
 *
 * | The ticket's channel | What goes out | `sent_at` is set |
 * |---|---|---|
 * | `chat` (widget) | a `csat` frame to the conversation; the card is also read over REST | now: the card is offered |
 * | `telegram` | a `telegram.notice` of kind `csat_survey`: the question, five score buttons, Add a comment | when Telegram accepts the message |
 * | anything else | an `email_deliveries` row of kind `csat` and its `email.send` | when the relay accepts the email |
 *
 * Email and Telegram go through the outbox like every message to a customer
 * (DOMAIN-RULES §6), so the survey and its sending commit together. A ticket
 * with nobody to reach — no address, no chat — is left `pending`, and the agent
 * still has the link to share.
 */

export type CsatDeliveryOutcome = 'widget' | 'telegram' | 'email' | 'unreachable';

export interface CsatDeliveryDependencies {
  readonly repository: Pick<CsatRepository, 'markSent'>;
  readonly email: Pick<OutboundEmailService, 'queueCsatSurvey'>;
  readonly telegram: Pick<TelegramRepository, 'chatForTicket'>;
  readonly locales: Pick<TicketLifecycleRepository, 'localeForContact'>;
  readonly widget: WidgetBroadcast;
}

export class CsatDelivery {
  readonly #deps: CsatDeliveryDependencies;

  constructor(deps: CsatDeliveryDependencies) {
    this.#deps = deps;
  }

  async deliver(
    tx: DbTransaction,
    brandId: string,
    ticket: Pick<ClosedTicketFacts, 'channel' | 'contactId' | 'departmentId'> & { id: string },
    survey: CsatResponse,
    now: Date,
  ): Promise<CsatDeliveryOutcome> {
    switch (ticket.channel) {
      case 'chat':
        await this.#deps.repository.markSent(tx, survey.id, now);
        await this.#deps.widget.emit({
          room: conversationRoom(ticket.id),
          event: WIDGET_EVENTS.csat,
          data: {
            conversationId: ticket.id,
            state: 'open',
            rating: null,
            comment: null,
            skippedAt: null,
          },
          seq: null,
        });
        return 'widget';
      case 'telegram': {
        const chat = await this.#deps.telegram.chatForTicket(tx, ticket);
        if (chat === undefined) {
          return 'unreachable';
        }
        const locale: Locale = await this.#deps.locales.localeForContact(
          tx,
          brandId,
          ticket.contactId,
        );
        await enqueueTelegramNotice(tx, brandId, {
          botId: chat.botId,
          chatId: chat.chatId,
          notice: 'csat_survey',
          locale,
          csat: { surveyId: survey.id },
        });
        return 'telegram';
      }
      default: {
        const queued = await this.#deps.email.queueCsatSurvey(tx, {
          brandId,
          ticketId: ticket.id,
          surveyId: survey.id,
        });
        return queued === undefined ? 'unreachable' : 'email';
      }
    }
  }
}
