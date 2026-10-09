import type { DbTransaction, TicketMessage as TicketMessageRow, WidgetVisitor } from '@helpdock/db';
import {
  type AiFeedback,
  type ContentPolicy,
  type WidgetConversation,
  type WidgetConversationList,
  type WidgetMessage,
  type WidgetMessagePage,
  type WidgetMessagesQuery,
  type WidgetPrechatAnswers,
  type WidgetQueue,
  type WidgetSendResponse,
  type WidgetStartResponse,
  widgetPrechatAnswersSchema,
  widgetSendRequestSchema,
  widgetStartRequestSchema,
} from '@helpdock/schemas';
import type { z } from 'zod';
import { readAiMeta } from '../ai/auto-reply/ai-meta.js';
import { pauseAi } from '../ai/auto-reply/ai-pause.js';
import { AutoReplyRepository } from '../ai/auto-reply/auto-reply.repository.js';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { requestAutoAssign } from '../assignment/assignment-events.js';
import { routesAutomatically } from '../assignment/ticket-assignment.js';
import type { CaptchaVerifier } from '../captcha/captcha-keys.js';
import { ContactFailure } from '../contacts/contact-failure.js';
import { attachUnverifiedIdentity, findOrCreateContactByIdentity } from '../contacts/identity.js';
import { recordHandoff } from '../help-center/feedback/handoff.js';
import { readContentPolicy } from '../media/content-policy.js';
import { AttachmentLinkError, linkAttachmentsToMessage } from '../media/link.js';
import type { MediaRepository } from '../media/media.repository.js';
import type { BusinessHoursService } from '../sla/business-hours.service.js';
import { parseCustomValues } from '../ticketing/custom-values.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type {
  LifecycleContext,
  TicketLifecycleService,
} from '../tickets/lifecycle/lifecycle.service.js';
import { TicketLifecycleFailure } from '../tickets/lifecycle/lifecycle-failure.js';
import { type ActivityActor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import { conversationAccess } from './conversation-access.js';
import { plainTextToHtml, subjectFrom } from './plain-text.js';
import type { TicketWithStatus, WidgetRepository } from './widget.repository.js';
import { WidgetFailure } from './widget-failure.js';
import type { VisitorScope, WidgetGate, WidgetRequestFacts } from './widget-gate.js';
import { calendarHours } from './widget-hours.js';
import { toWidgetConversation, toWidgetMessage } from './widget-view.js';

/**
 * A visitor's conversations (M4-02, M4-04): the widget's half of
 * ARCHITECTURE §8's `ConversationRouter`.
 *
 * "Widget messages become ticket messages on a `chat`-channel ticket" — the
 * ticket is written with the same repository, the same lifecycle calls and
 * the same two rows (`ticket_activity`, `outbox`) as a ticket typed into the
 * admin or filed from an email, so assignment, SLAs, rules and notifications
 * see a widget conversation exactly as they see any other ticket.
 *
 * **Delivery (DOMAIN-RULES §7).** A message is keyed by its `clientId`. The
 * ticket row is locked (`nextSeq`) before the `clientId` is looked up, so a
 * retry that races its first attempt waits for it and then finds it; a
 * conversation's first message has no ticket to lock yet, so an advisory lock
 * on `(visitor, clientId)` does the same job. Either way a double submit,
 * a retry after a dropped connection and a retry after an api restart all
 * answer the one message that exists.
 */

export interface WidgetConversationsDependencies {
  readonly gate: WidgetGate;
  readonly widget: WidgetRepository;
  readonly tickets: TicketRepository;
  readonly lifecycle: TicketLifecycleService;
  readonly lifecycleReads: TicketLifecycleRepository;
  readonly assignment: AssignmentRepository;
  readonly media: MediaRepository;
  readonly captcha: CaptchaVerifier;
  /** M7-06: whose hours a conversation's `hours` are judged by. */
  readonly businessHours: Pick<BusinessHoursService, 'calendarsFor'>;
}

type StartInput = z.input<typeof widgetStartRequestSchema>;
type SendInput = z.input<typeof widgetSendRequestSchema>;

/** Emoji, which a brand may switch off (REQUIREMENTS §4.6). */
const EMOJI = /\p{Extended_Pictographic}/u;

const autoReplies = new AutoReplyRepository();

export class WidgetConversationsService {
  readonly #deps: WidgetConversationsDependencies;

  constructor(deps: WidgetConversationsDependencies) {
    this.#deps = deps;
  }

  list(
    brandId: string,
    facts: WidgetRequestFacts,
    now: Date = new Date(),
  ): Promise<WidgetConversationList> {
    return this.#deps.gate.visitor(brandId, facts, { write: false }, async (scope) => {
      const entries = (
        await this.#deps.widget.conversationsOf(
          scope.tx,
          scope.visitor,
          scope.settings.signedIdentitySeesAllChannels,
        )
      ).filter((entry) => this.#access(scope, entry) !== 'none');

      return { conversations: await this.#views(scope, entries, now) };
    });
  }

  get(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    now: Date = new Date(),
  ): Promise<WidgetConversation> {
    return this.#deps.gate.visitor(brandId, facts, { write: false }, async (scope) => {
      const entry = await this.#require(scope, conversationId);
      const [view] = await this.#views(scope, [entry], now);
      /* c8 ignore next 3 -- one entry in, one view out. */
      if (view === undefined) {
        throw new WidgetFailure('not_found');
      }
      return view;
    });
  }

  /**
   * M7-06: "Talk to a human". Pauses the assistant for the rest of the
   * conversation (DOMAIN-RULES §9) under the ticket's row lock, the one a
   * late auto-reply job takes before it sends, so nothing the assistant
   * prepared reaches the visitor after this returns. Pressing it twice, or
   * after the team already took over, changes nothing.
   */
  handoff(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    now: Date = new Date(),
  ): Promise<WidgetConversation> {
    return this.#deps.gate.visitor(brandId, facts, { write: true }, async (scope) => {
      const entry = await this.#require(scope, conversationId);
      if (this.#access(scope, entry) !== 'write') {
        throw new WidgetFailure('read_only');
      }
      await this.#deps.tickets.nextSeq(scope.tx, entry.ticket.id);
      // The button is the assistant's: pressing it is taking part in an
      // assistant conversation (DOMAIN-RULES §15's "eligible").
      await autoReplies.markEligible(scope.tx, entry.ticket.id, now);
      const paused = await pauseAi(scope.tx, {
        brandId,
        ticketId: entry.ticket.id,
        reason: 'customer_request',
        at: now,
        actorId: scope.visitor.id,
      });
      if (paused !== undefined) {
        await enqueueTicketEvent(scope.tx, brandId, TICKET_EVENTS.updated, {
          ticketId: paused.id,
          departmentId: paused.departmentId,
        });
      }
      const [view] = await this.#views(
        scope,
        [paused === undefined ? entry : { ...entry, ticket: paused }],
        now,
      );
      /* c8 ignore next 3 -- one entry in, one view out. */
      if (view === undefined) {
        throw new WidgetFailure('not_found');
      }
      return view;
    });
  }

  /** M7-06: "Was this helpful?" on one of the assistant's answers in this conversation. */
  feedback(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    messageId: string,
    feedback: AiFeedback,
  ): Promise<WidgetMessage> {
    return this.#deps.gate.visitor(brandId, facts, { write: true }, async (scope) => {
      const entry = await this.#require(scope, conversationId);
      const row = await this.#deps.widget.message(scope.tx, messageId);
      const meta = row === undefined ? undefined : readAiMeta(row.aiMeta);
      if (row === undefined || row.ticketId !== entry.ticket.id || meta?.kind !== 'answer') {
        throw new WidgetFailure('not_found');
      }
      const updated = { ...meta, feedback };
      await autoReplies.saveFeedback(scope.tx, row.id, updated);
      return toWidgetMessage({ ...row, aiMeta: updated }, [], {
        staffNames: new Map(),
        showAgentIdentity: false,
      });
    });
  }

  /** `GET …/messages?after=<seq>`: the catch-up of §7. */
  messages(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    query: WidgetMessagesQuery,
  ): Promise<WidgetMessagePage> {
    return this.#deps.gate.visitor(brandId, facts, { write: false }, async (scope) => {
      const entry = await this.#require(scope, conversationId);
      return this.page(scope, entry.ticket.id, query);
    });
  }

  /** Also the gateway's join answer and the SSE stream's opening catch-up. */
  async page(
    scope: VisitorScope,
    ticketId: string,
    query: WidgetMessagesQuery,
  ): Promise<WidgetMessagePage> {
    const { tx } = scope;
    const rows = await this.#deps.widget.visibleMessagesAfter(
      tx,
      ticketId,
      query.after,
      query.limit,
    );
    const page = rows.slice(0, query.limit);
    const lastSeq = (await this.#deps.widget.lastSeqs(tx, [ticketId])).get(ticketId) ?? 0;
    const hasMore = rows.length > query.limit;

    return {
      messages: await this.#messageViews(scope, page),
      // With more to come the cursor is the last message returned, so the next
      // page starts there; otherwise it is the thread's high-water mark, notes
      // included, so a note's gap is not a gap again (§7).
      lastSeq: hasMore ? (page.at(-1)?.seq ?? query.after) : Math.max(lastSeq, query.after),
      hasMore,
    };
  }

  /**
   * `POST …/conversations`: opens a `chat` ticket, with the visitor's first
   * message when the call carries text and empty when it does not — the
   * widget opens the conversation before the first message is sent, and the
   * pre-chat form opens it with the answers alone.
   */
  async start(
    brandId: string,
    facts: WidgetRequestFacts,
    input: StartInput,
    now: Date = new Date(),
  ): Promise<WidgetStartResponse> {
    const body = widgetStartRequestSchema.parse(input);

    // Once outside the write transaction, so a retry of a start that already
    // committed is answered without spending the CAPTCHA token again.
    const existing = await this.#deps.gate.visitor(brandId, facts, { write: false }, (scope) =>
      this.#startReplayed(scope, body.clientId, now),
    );
    if (existing !== undefined) {
      return existing;
    }

    return this.#deps.gate.visitor(brandId, facts, { write: true }, async (scope) => {
      const { tx, visitor, settings } = scope;
      await this.#deps.widget.lockClientId(tx, visitor.id, body.clientId);
      const replay = await this.#startReplayed(scope, body.clientId, now);
      if (replay !== undefined) {
        return replay;
      }

      if (settings.captchaEnabled) {
        const check = await this.#deps.captcha.verify({
          brandId,
          token: body.captchaToken,
          remoteIp: facts.ip,
          tx,
        });
        // ADR 0003: refused "before any ticket, contact or conversation row".
        if (check === 'failed') {
          throw new WidgetFailure('captcha_required');
        }
      }
      this.#checkText(scope, body.text);

      // The pre-chat form's answers, or the contact form's, which asks the
      // same fields: both are unverified (§4.1), whichever form sent them.
      const prechat =
        body.prechat === undefined ? undefined : widgetPrechatAnswersSchema.parse(body.prechat);
      const contactId = await this.#contactFor(scope, prechat);
      const actor = actorFor(visitor);
      const context: LifecycleContext = { tx, brandId, actor, now };

      const { tickets: repository, lifecycleReads } = this.#deps;
      const status = await repository.findDefaultStatus(tx);
      const prefix = await repository.brandPrefix(tx, brandId);
      const departmentId = await this.#deps.widget.firstDepartment(tx);
      /* c8 ignore next 3 -- every brand is seeded with statuses, a prefix and a department. */
      if (status === undefined || prefix === undefined || departmentId === undefined) {
        throw new WidgetFailure('unavailable');
      }
      const locale = await lifecycleReads.localeForContact(tx, brandId, contactId);
      const custom = await this.#prechatCustom(scope, prechat);

      const ticket = await repository.insertTicket(tx, {
        brandId,
        departmentId,
        number: await repository.nextNumber(tx, brandId),
        prefix,
        subject: subjectFrom(body.text, locale),
        statusId: status.id,
        priority: 'medium',
        channel: 'chat',
        contactId,
        visitorId: visitor.id,
        visitorClientId: body.clientId,
        ...(custom === undefined ? {} : { custom }),
      });

      const message =
        body.text === ''
          ? null
          : await this.#insertVisitorMessage(tx, {
              brandId,
              ticket,
              seq: await repository.nextSeq(tx, ticket.id),
              clientId: body.clientId,
              text: body.text,
              contactId,
            });

      await writeTicketActivity(tx, {
        brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        actor,
        action: 'ticket.created',
        to: { subject: ticket.subject, statusId: status.id, priority: ticket.priority },
      });
      // M5-08: "Still need help?" from a help center article.
      await recordHandoff(tx, { brandId, ticket, actor, articleId: body.articleId, locale });
      // M3-02: the clocks start when the conversation opens, as for any ticket.
      await this.#deps.lifecycle.onCreated({ ...context, now: ticket.createdAt }, ticket, status);
      await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.created, {
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
      });
      if (message !== null) {
        await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.replied, {
          ticketId: ticket.id,
          departmentId: ticket.departmentId,
          messageId: message.id,
          seq: message.seq,
          kind: 'public',
        });
      }
      if (await routesAutomatically(this.#deps.assignment, tx, ticket.departmentId)) {
        await requestAutoAssign(tx, brandId, { ticketId: ticket.id, trigger: 'routed' });
      }

      return this.#startResponse(scope, { ticket, status }, message, now);
    });
  }

  /** `POST …/conversations/:id/messages`. */
  send(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    input: SendInput,
    now: Date = new Date(),
  ): Promise<WidgetSendResponse> {
    const body = widgetSendRequestSchema.parse(input);

    return this.#deps.gate.visitor(brandId, facts, { write: true }, async (scope) => {
      const { tx, visitor } = scope;
      const entry = await this.#require(scope, conversationId);
      const { ticket, status } = entry;
      const repository = this.#deps.tickets;

      // §7: the lock first, then the `clientId`, so a racing retry finds the row.
      let seq = await repository.nextSeq(tx, ticket.id);
      const existing =
        (await repository.findMessageByClientId(tx, ticket.id, body.clientId)) ??
        (await this.#deps.lifecycleReads.findContinuationMessage(tx, ticket.id, body.clientId));
      if (existing !== undefined) {
        const landed = await this.#deps.widget.conversation(tx, existing.ticketId);
        /* c8 ignore next 3 -- the message was just read from that ticket. */
        if (landed === undefined) {
          throw new WidgetFailure('not_found');
        }
        return this.#response(scope, landed, existing, now);
      }

      if (this.#access(scope, entry) !== 'write') {
        throw new WidgetFailure('read_only');
      }
      this.#checkText(scope, body.text);

      const actor = actorFor(visitor);
      const context: LifecycleContext = { tx, brandId, actor, now };
      let landing: Awaited<ReturnType<TicketLifecycleService['onCustomerReply']>>;
      try {
        // §2.2 rows 1 and 5, and §2.3's reopen policy: a reply to a closed
        // conversation reopens it or continues on a new one.
        landing = status.isSpam
          ? { ticket, status, continued: false }
          : await this.#deps.lifecycle.onCustomerReply(context, ticket, status);
      } catch (error) {
        if (error instanceof TicketLifecycleFailure) {
          throw new WidgetFailure('read_only');
        }
        /* c8 ignore next 2 -- the lifecycle throws nothing else. */
        throw error;
      }
      const target = landing.ticket;
      if (target.id !== ticket.id) {
        seq = await repository.nextSeq(tx, target.id);
      }

      const contactId = target.contactId ?? visitor.contactId;
      const subject = await this.#subjectOnFirstMessage(scope, target, body.text);
      const message = await this.#insertVisitorMessage(tx, {
        brandId,
        ticket: target,
        seq,
        clientId: body.clientId,
        text: body.text,
        contactId,
      });
      await this.#link(scope, {
        ticketId: ticket.id,
        landingTicketId: target.id,
        messageId: message.id,
        attachmentIds: body.attachmentIds ?? [],
      });

      await writeTicketActivity(tx, {
        brandId,
        ticketId: target.id,
        departmentId: target.departmentId,
        actor,
        action: 'ticket.replied',
        to: { messageId: message.id, seq },
      });
      await repository.updateTicket(tx, target.id, subject === undefined ? {} : { subject });
      await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.replied, {
        ticketId: target.id,
        departmentId: target.departmentId,
        messageId: message.id,
        seq,
        kind: 'public',
      });

      const landed = await this.#deps.widget.conversation(tx, target.id);
      /* c8 ignore next 3 -- written in this transaction. */
      if (landed === undefined) {
        throw new WidgetFailure('not_found');
      }
      return this.#response(scope, landed, message, now);
    });
  }

  /** The conversation's high-water mark, notes included: the cursor a join answers with. */
  async lastSeqOf(scope: VisitorScope, ticketId: string): Promise<number> {
    return (await this.#deps.widget.lastSeqs(scope.tx, [ticketId])).get(ticketId) ?? 0;
  }

  /** M4-04's queue position, for the socket's join and `GET …/queue`. */
  queue(brandId: string, facts: WidgetRequestFacts, conversationId: string): Promise<WidgetQueue> {
    return this.#deps.gate.visitor(brandId, facts, { write: false }, async (scope) =>
      this.queueOf(scope, await this.#require(scope, conversationId)),
    );
  }

  async queueOf(scope: VisitorScope, entry: TicketWithStatus): Promise<WidgetQueue> {
    return {
      conversationId: entry.ticket.id,
      position: await this.#deps.widget.queuePosition(scope.tx, entry),
    };
  }

  /** The ticket, if this visitor may see it (§4.1–4.2); otherwise not found. */
  async require(scope: VisitorScope, conversationId: string): Promise<TicketWithStatus> {
    return this.#require(scope, conversationId);
  }

  // ---------------------------------------------------------------- internals

  #access(scope: VisitorScope, entry: TicketWithStatus) {
    return conversationAccess(entry.ticket, scope.visitor, {
      seesAllChannels: scope.settings.signedIdentitySeesAllChannels,
    });
  }

  async #require(scope: VisitorScope, conversationId: string): Promise<TicketWithStatus> {
    const entry = await this.#deps.widget.conversation(scope.tx, conversationId);
    if (entry === undefined || this.#access(scope, entry) === 'none') {
      throw new WidgetFailure('not_found');
    }
    return entry;
  }

  /** A start already made with this `clientId`: the conversation, and its first message if it had one. */
  async #startReplayed(
    scope: VisitorScope,
    clientId: string,
    now: Date,
  ): Promise<WidgetStartResponse | undefined> {
    const entry = await this.#deps.widget.conversationStartedWith(
      scope.tx,
      scope.visitor.id,
      clientId,
    );
    if (entry === undefined) {
      return undefined;
    }
    const message = await this.#deps.tickets.findMessageByClientId(
      scope.tx,
      entry.ticket.id,
      clientId,
    );
    return this.#startResponse(scope, entry, message ?? null, now);
  }

  /**
   * A conversation opened without text is named "Chat conversation" until
   * the visitor writes; their first message names it as it would have named
   * a conversation it opened.
   */
  async #subjectOnFirstMessage(
    scope: VisitorScope,
    ticket: TicketWithStatus['ticket'],
    text: string,
  ): Promise<string | undefined> {
    if (ticket.visitorClientId === null || text === '') {
      return undefined;
    }
    const earlier = await this.#deps.widget.visibleMessagesAfter(scope.tx, ticket.id, 0, 1);
    if (earlier.length > 0) {
      return undefined;
    }
    const locale = await this.#deps.lifecycleReads.localeForContact(
      scope.tx,
      scope.brand.id,
      ticket.contactId,
    );
    return subjectFrom(text, locale);
  }

  async #startResponse(
    scope: VisitorScope,
    entry: TicketWithStatus,
    message: TicketMessageRow | null,
    now: Date,
  ): Promise<WidgetStartResponse> {
    if (message !== null) {
      return this.#response(scope, entry, message, now);
    }
    const [conversation] = await this.#views(scope, [entry], now);
    /* c8 ignore next 3 -- one in, one out. */
    if (conversation === undefined) {
      throw new WidgetFailure('not_found');
    }
    return { conversation, message: null };
  }

  #checkText(scope: VisitorScope, text: string): void {
    const policy = this.#policy(scope);
    if (text !== '' && !policy.text) {
      throw new WidgetFailure('content_policy', 'This brand does not accept text messages');
    }
    if (!policy.emoji && EMOJI.test(text)) {
      throw new WidgetFailure('content_policy', 'This brand does not accept emoji');
    }
  }

  #policy(scope: VisitorScope): ContentPolicy {
    return readContentPolicy(scope.brand.contentPolicy);
  }

  /**
   * Whose conversation this is: the verified contact while a signed identity
   * vouches for the visitor, otherwise the visitor's own contact — created on
   * the first message, holding the visitor id as a verified identifier (§4.4).
   * A pre-chat email is attached **unverified** and never switches contacts:
   * typing somebody's address opens nothing of theirs (§4.1).
   */
  async #contactFor(
    scope: VisitorScope,
    prechat: WidgetPrechatAnswers | undefined,
  ): Promise<string> {
    const { tx, brand, visitor } = scope;
    let contactId = visitor.verifiedContactId ?? visitor.contactId;

    if (contactId === null) {
      const name = prechat?.name?.trim();
      const { contact } = await findOrCreateContactByIdentity(
        tx,
        brand.id,
        { kind: 'visitor', value: visitor.id, source: 'widget.visitor' },
        { name: name === undefined || name === '' ? visitorName(visitor.id) : name },
      );
      contactId = contact.id;
      await this.#deps.widget.updateVisitor(tx, visitor.id, { contactId });
    }

    const email = prechat?.email?.trim();
    if (email !== undefined && email !== '') {
      try {
        await attachUnverifiedIdentity(tx, brand.id, contactId, {
          kind: 'email',
          value: email,
          source: 'widget.form',
        });
      } catch (error) {
        if (error instanceof ContactFailure) {
          throw new WidgetFailure('invalid_payload', 'That email address is not valid');
        }
        /* c8 ignore next 2 -- nothing else in that call throws. */
        throw error;
      }
    }

    return contactId;
  }

  /** The pre-chat's custom answers, for the fields the form asked, checked like any ticket field. */
  async #prechatCustom(
    scope: VisitorScope,
    prechat: WidgetPrechatAnswers | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const custom = prechat?.custom;
    if (custom === undefined) {
      return undefined;
    }
    const asked = new Set(
      scope.settings.conversation.prechatFields.flatMap((field) =>
        field.kind === 'custom' ? [field.key] : [],
      ),
    );
    const answers = Object.fromEntries(Object.entries(custom).filter(([key]) => asked.has(key)));
    if (Object.keys(answers).length === 0) {
      return undefined;
    }

    return parseCustomValues(scope.tx, 'ticket', answers, { partial: true });
  }

  #insertVisitorMessage(
    tx: DbTransaction,
    input: {
      readonly brandId: string;
      readonly ticket: TicketWithStatus['ticket'];
      readonly seq: number;
      readonly clientId: string;
      readonly text: string;
      readonly contactId: string | null;
    },
  ): Promise<TicketMessageRow> {
    return this.#deps.tickets.insertMessage(tx, {
      brandId: input.brandId,
      ticketId: input.ticket.id,
      departmentId: input.ticket.departmentId,
      seq: input.seq,
      clientId: input.clientId,
      kind: 'public',
      authorType: 'contact',
      authorId: input.contactId,
      bodyHtml: plainTextToHtml(input.text),
      bodyText: input.text,
      channel: 'chat',
    });
  }

  async #link(
    scope: VisitorScope,
    input: {
      readonly ticketId: string;
      readonly landingTicketId: string;
      readonly messageId: string;
      readonly attachmentIds: readonly string[];
    },
  ): Promise<void> {
    if (input.attachmentIds.length === 0) {
      return;
    }
    try {
      await linkAttachmentsToMessage(
        scope.tx,
        {
          ...input,
          policy: this.#policy(scope),
          // The uploader identity `widget-uploads.service.ts` wrote (media/uploader.ts).
          uploaderType: 'contact',
          uploaderId: scope.visitor.id,
        },
        this.#deps.media,
      );
    } catch (error) {
      if (error instanceof AttachmentLinkError) {
        throw new WidgetFailure(
          error.problem === 'too_many' ? 'content_policy' : 'not_found',
          error.message,
        );
      }
      /* c8 ignore next 2 -- nothing else in that call throws. */
      throw error;
    }
  }

  async #response(
    scope: VisitorScope,
    entry: TicketWithStatus,
    message: TicketMessageRow,
    now: Date,
  ): Promise<WidgetSendResponse> {
    const [conversation] = await this.#views(scope, [entry], now);
    const [view] = await this.#messageViews(scope, [message]);
    /* c8 ignore next 3 -- one in, one out. */
    if (conversation === undefined || view === undefined) {
      throw new WidgetFailure('not_found');
    }
    return { conversation, message: view };
  }

  /**
   * Each conversation with the hours of the team that answers it: its
   * department's calendar, else the brand's (DOMAIN-RULES §3.1), judged at
   * `now`. One read of the calendar rows serves the whole list.
   */
  async #views(
    scope: Pick<VisitorScope, 'tx' | 'brand'>,
    entries: readonly TicketWithStatus[],
    now: Date,
  ): Promise<WidgetConversation[]> {
    const ids = entries.map((entry) => entry.ticket.id);
    const seqs = await this.#deps.widget.lastSeqs(scope.tx, ids);
    const continued = await this.#deps.widget.continuations(scope.tx, ids);
    const calendarOf = await this.#deps.businessHours.calendarsFor(scope.brand.id, scope.tx);

    return entries.map((entry) =>
      toWidgetConversation(
        entry,
        seqs.get(entry.ticket.id) ?? 0,
        continued.get(entry.ticket.id) ?? null,
        calendarHours(calendarOf(entry.ticket.departmentId), now),
      ),
    );
  }

  async #messageViews(
    scope: VisitorScope,
    rows: readonly TicketMessageRow[],
  ): Promise<WidgetMessage[]> {
    const files = await this.#deps.widget.attachmentsOf(
      scope.tx,
      rows.map((row) => row.id),
    );
    const staffNames = await this.#deps.widget.staffNames(
      scope.tx,
      rows.flatMap((row) =>
        row.authorType === 'staff' && row.authorId !== null ? [row.authorId] : [],
      ),
    );

    return rows.map((row) =>
      toWidgetMessage(row, files.get(row.id) ?? [], {
        staffNames,
        showAgentIdentity: scope.settings.conversation.showAgentIdentity,
      }),
    );
  }
}

/** The visitor, as `ticket_activity` and the lifecycle record them. */
export const actorFor = (visitor: Pick<WidgetVisitor, 'id'>): ActivityActor => ({
  actorType: 'visitor',
  actorId: visitor.id,
  via: 'ui',
});

/** "Visitor 3f9a2c": a contact needs a name, and a visitor who gave none is known by their id. */
export const visitorName = (visitorId: string): string => `Visitor ${visitorId.slice(-6)}`;
