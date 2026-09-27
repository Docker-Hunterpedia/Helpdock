import { REALTIME_EVENTS, ticketRoom } from '@helpdock/schemas';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import { ContactFailure } from '../contacts/contact-failure.js';
import { requireNormalised } from '../contacts/identity.js';
import type { OutboundEmailService } from '../email/outbound-email.service.js';
import type { RealtimePublisher } from '../realtime/publisher.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { WidgetConversationsService } from './widget-conversations.service.js';
import { WidgetFailure } from './widget-failure.js';
import type { VisitorScope, WidgetGate, WidgetRequestFacts } from './widget-gate.js';

/**
 * What a visitor does beside writing messages (M4-04, M4-08): typing, reading
 * and asking for a transcript.
 *
 * Typing and read receipts go to the staff side over the `/staff` namespace's
 * `ticket:<id>` room — ephemeral, unacknowledged, never stored (§7). The
 * publisher's emit is not local, so the Redis adapter carries it to every
 * replica's agents.
 *
 * A transcript goes through the outbox like every email (DOMAIN-RULES §6):
 * one `email_deliveries` row and one `email.send` job in this transaction,
 * sent from the brand's outbound email by the worker.
 */

/** Transcripts of one conversation: enough to fix a typo in the address, not to mail-bomb one. */
export const WIDGET_TRANSCRIPT_RULE: RateLimitRule = {
  bucket: 'widget-transcript',
  limit: 3,
  windowSeconds: 3600,
};

export class WidgetActivityService {
  readonly #gate: WidgetGate;
  readonly #conversations: WidgetConversationsService;
  readonly #publisher: Pick<RealtimePublisher, 'emitToRoom'>;
  readonly #outbound: Pick<OutboundEmailService, 'queueTranscript'>;
  readonly #lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  readonly #limiter: RateLimiter;

  constructor(deps: {
    readonly gate: WidgetGate;
    readonly conversations: WidgetConversationsService;
    readonly publisher: Pick<RealtimePublisher, 'emitToRoom'>;
    readonly outbound: Pick<OutboundEmailService, 'queueTranscript'>;
    readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
    readonly limiter: RateLimiter;
  }) {
    this.#gate = deps.gate;
    this.#conversations = deps.conversations;
    this.#publisher = deps.publisher;
    this.#outbound = deps.outbound;
    this.#lifecycleReads = deps.lifecycleReads;
    this.#limiter = deps.limiter;
  }

  typing(brandId: string, facts: WidgetRequestFacts, conversationId: string, typing: boolean) {
    return this.#gate.visitor(brandId, facts, { write: false }, (scope) =>
      this.typingIn(scope, conversationId, typing),
    );
  }

  async typingIn(scope: VisitorScope, conversationId: string, typing: boolean): Promise<void> {
    const { ticket } = await this.#conversations.require(scope, conversationId);
    this.#publisher.emitToRoom(ticketRoom(ticket.id), REALTIME_EVENTS.visitorTyping, {
      brandId: scope.brand.id,
      ticketId: ticket.id,
      typing,
    });
  }

  read(brandId: string, facts: WidgetRequestFacts, conversationId: string, seq: number) {
    return this.#gate.visitor(brandId, facts, { write: false }, (scope) =>
      this.readIn(scope, conversationId, seq),
    );
  }

  async readIn(scope: VisitorScope, conversationId: string, seq: number): Promise<void> {
    const { ticket } = await this.#conversations.require(scope, conversationId);
    this.#publisher.emitToRoom(ticketRoom(ticket.id), REALTIME_EVENTS.visitorRead, {
      brandId: scope.brand.id,
      ticketId: ticket.id,
      seq,
    });
  }

  /**
   * "Transcript by email sends only that conversation, to the address the
   * visitor entered, and the email contains no links that grant access"
   * (§4.1). Answers whether it was queued: a brand with no sender at all has
   * nowhere to send from, which is not the visitor's fault to be told about.
   */
  transcript(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    email: string,
  ): Promise<void> {
    return this.#gate.visitor(brandId, facts, { write: true }, async (scope) => {
      if (!scope.settings.conversation.transcriptEnabled) {
        throw new WidgetFailure('unavailable', 'This brand does not send transcripts');
      }
      const { ticket } = await this.#conversations.require(scope, conversationId);
      if (ticket.channel !== 'chat') {
        throw new WidgetFailure('read_only');
      }

      let address: string;
      try {
        address = requireNormalised('email', email);
      } catch (error) {
        if (error instanceof ContactFailure) {
          throw new WidgetFailure('invalid_payload', 'That email address is not valid');
        }
        /* c8 ignore next 2 -- nothing else in that call throws. */
        throw error;
      }
      if (!(await this.#limiter.consume(WIDGET_TRANSCRIPT_RULE, ticket.id))) {
        throw new WidgetFailure('rate_limited');
      }

      await this.#outbound.queueTranscript(scope.tx, {
        brandId,
        ticketId: ticket.id,
        to: address,
        locale: await this.#lifecycleReads.localeForContact(scope.tx, brandId, ticket.contactId),
      });
    });
  }
}
