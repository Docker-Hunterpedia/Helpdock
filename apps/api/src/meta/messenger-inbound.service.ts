import {
  GraphApiFailure,
  type MetaEvent,
  type MetaInboundLabels,
  metaIdentityValue,
  parseGraph,
  toMessengerInboundMessage,
} from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { DbTransaction, MetaAccount as MetaAccountRow } from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import { normaliseIdentity } from '@helpdock/schemas';
import { z } from 'zod';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { TicketRepository } from '../tickets/tickets.repository.js';
import type { DeferredAttachmentSink } from './deferred-sink.js';
import type { GraphClientFactory } from './graph-client-factory.js';
import type { MetaRepository } from './meta.repository.js';
import type {
  MetaEventContext,
  MetaEventOutcome,
  MetaInboundLog,
  PlatformInboundService,
} from './meta-inbound.service.js';
import { metaMessageSeen } from './meta-inbound-gate.js';
import type { MetaConversationRouter } from './meta-router.js';
import { metaText } from './meta-text.js';
import {
  type SystemLine,
  type ThreadRef,
  ticketOfMessage,
  writeSystemLine,
} from './meta-thread.js';

/**
 * A Messenger Page's events into one brand (M10-04, ADR 0025, DOMAIN-RULES
 * §4.7 and §4.8): the platform half of the seam `MetaInboundService` fills,
 * after the webhook has found the account and the seam has already answered
 * the two questions every platform asks of a customer's message (filed
 * before? blocked?).
 *
 * | The event is | What happens |
 * |---|---|
 * | `message` | the router files it under `<page id>:<psid>`; the customer's name is read from Graph once, when the conversation begins; its files are `pending` attachments and `meta.media` outbox rows |
 * | `echo` | a message the Page sent: Helpdock's own (by `app_id`, or `metadata` naming one of this account's deliveries) is dropped silently, any other is dropped and counted |
 * | `delivery`, `read` | every delivery of the conversation sent at or before the watermark moves to `delivered` / `read`; the `mids` a `delivery` names move individually |
 * | `reaction`, `edit` | a system line on the ticket of the message they are about |
 * | `unsupported` | a system line on the conversation's ticket, when it has one |
 * | `policy_enforcement` | counted and dropped, and recorded as the account's `last_error` |
 * | `postback`, `referral`, `standby` and the rest | counted and dropped |
 *
 * Everything runs in the route's transaction, as the system principal. What an
 * event causes outside the database — the media fetch — is an outbox row, never
 * a call made here. The one call that is made is the customer's name, below.
 */

const HANDLED: MetaEventOutcome = { outcome: 'handled' };

const ignored = (reason: string): MetaEventOutcome => ({ outcome: 'ignored', reason });

type Event<Kind extends MetaEvent['kind']> = Extract<MetaEvent, { kind: Kind }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A page-scoped id is a run of digits; this only keeps an odd one out of a Graph path. */
const PSID_IN_A_PATH = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest contact name kept, as the contact layer keeps it. */
const NAME_MAX_LENGTH = 200;

/**
 * How long the webhook waits for the customer's name. Meta wants an answer in
 * seconds (ADR 0025, 6) and this call is made inside the request, so a slow
 * Graph costs the message its name, never its delivery.
 */
export const PROFILE_TIMEOUT_MS = 3_000;

/** `GET /{psid}?fields=first_name,last_name`. Loose, like every Graph answer. */
const messengerProfileSchema = z.looseObject({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

const TIMED_OUT = Symbol('timed out');

/** The promise's value, or {@link TIMED_OUT}; a rejection after the timeout is swallowed with it. */
const orTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const fullName = (profile: z.infer<typeof messengerProfileSchema>): string | null => {
  const name = [profile.first_name, profile.last_name]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ');
  return name === '' ? null : name.slice(0, NAME_MAX_LENGTH);
};

/**
 * Whether the contact layer can spell this customer's identity. It refuses
 * anything but letters, digits and `._:-`, which would fail the whole batch and
 * have Meta redeliver it for ever; Meta's own ids are never such a thing, so this
 * is the poison-pill guard and not a rule.
 */
const isSpellable = (account: Pick<MetaAccountRow, 'externalId'>, customerId: string): boolean =>
  normaliseIdentity('messenger', metaIdentityValue('messenger', account.externalId, customerId)).ok;

const labelsFor = (locale: Locale): MetaInboundLabels => {
  const t = metaText(locale);
  return {
    location: t('thread.location'),
    contact: t('thread.contact'),
    story: { reply: t('thread.story.reply'), mention: t('thread.story.mention') },
  };
};

export interface MessengerInboundServiceOptions {
  readonly repository: Pick<
    MetaRepository,
    'conversation' | 'delivery' | 'advanceStatus' | 'advanceByWatermark' | 'markError'
  >;
  readonly router: Pick<MetaConversationRouter, 'route'>;
  readonly sink: Pick<DeferredAttachmentSink, 'store'>;
  readonly tickets: Pick<TicketRepository, 'insertMessage' | 'nextSeq' | 'findTicket'>;
  readonly lifecycleReads: Pick<TicketLifecycleRepository, 'localeForContact'>;
  readonly graph: GraphClientFactory;
  readonly keyring: Keyring;
  /** The install's Meta app id (`meta.appId`), empty when none is set. */
  readonly app: { appId(): Promise<string> };
  readonly log: MetaInboundLog;
  readonly profileTimeoutMs?: number;
}

export class MessengerInboundService implements PlatformInboundService {
  readonly #options: MessengerInboundServiceOptions;

  constructor(options: MessengerInboundServiceOptions) {
    this.#options = options;
  }

  async handle(context: MetaEventContext, event: MetaEvent): Promise<MetaEventOutcome> {
    switch (event.kind) {
      case 'message':
        return this.#message(context, event);
      case 'echo':
        return this.#echo(context, event);
      case 'delivery':
        return this.#receipt(context, event, 'delivered');
      case 'read':
        return this.#receipt(context, event, 'read');
      case 'reaction':
        return this.#reaction(context, event);
      case 'edit':
        return this.#edit(context, event);
      case 'unsupported':
        return this.#unsupported(context, event);
      case 'policy_enforcement':
        return this.#policy(context, event);
      case 'ignored':
        return ignored(event.reason);
      case 'postback':
      case 'referral':
        return ignored(event.kind);
      // A Page's webhook carries none of WhatsApp's or Instagram's kinds.
      default:
        this.#options.log.warn(
          { kind: event.kind, platform: event.platform },
          'messenger received an event of another platform; dropped',
        );
        return ignored(`unexpected-${event.kind}`);
    }
  }

  // --------------------------------------------------------------- messages

  async #message(context: MetaEventContext, event: Event<'message'>): Promise<MetaEventOutcome> {
    const { tx, account, now } = context;
    const { repository, router, sink, lifecycleReads } = this.#options;

    if (!isSpellable(account, event.customerId)) {
      return ignored('invalid-customer-id');
    }

    const conversation = await repository.conversation(tx, account.id, event.customerId);
    const locale = await lifecycleReads.localeForContact(
      tx,
      account.brandId,
      conversation?.contactId ?? null,
    );
    // Once per conversation, when it begins: a Page without the reviewed
    // feature answers every read with a refusal (an accepted gap), and asking
    // again on each message would cost the webhook a call for nothing.
    const profileName =
      conversation === undefined
        ? await this.#profileName(account, event.customerId)
        : conversation.profileName;

    const sentAt = event.timestamp !== null && event.timestamp < now ? event.timestamp : now;
    await router.route(
      { tx, brandId: account.brandId, account, now },
      toMessengerInboundMessage(
        {
          event: { ...event, profileName },
          accountExternalId: account.externalId,
          labels: labelsFor(locale),
        },
        sentAt,
      ),
      sink,
    );

    await this.#noteUnsupportedAttachments(context, event, locale);
    return HANDLED;
  }

  /**
   * An attachment of a type Helpdock cannot show rides on a message that was
   * filed for the rest of it; the agent is told something is missing.
   */
  async #noteUnsupportedAttachments(
    context: MetaEventContext,
    event: Event<'message'>,
    locale: Locale,
  ): Promise<void> {
    if (event.unsupportedAttachments.length === 0) {
      return;
    }
    const thread = await ticketOfMessage(context.tx, context.account, event.messageId);
    /* c8 ignore next 3 -- the router wrote this message a statement ago, in this transaction. */
    if (thread === undefined) {
      throw new Error('The routed message is not on a ticket');
    }
    await this.#writeLine(context, thread, {
      text: metaText(locale)('thread.unsupported'),
      key: `unsupported:${event.messageId}`,
    });
  }

  /**
   * The customer's name, or null: a refusal (the Page lacks the feature, 400
   * or 403), a Graph that is down or slow, or a reply without one. A name is
   * a convenience; none of these may cost the customer's message. Never stored
   * when it is not read (DOMAIN-RULES §4.7): the thread says "Messenger user".
   */
  async #profileName(account: MetaAccountRow, psid: string): Promise<string | null> {
    if (!PSID_IN_A_PATH.test(psid)) {
      return null;
    }
    const token = decryptSecret(account.accessToken, this.#options.keyring);
    try {
      const body = await orTimeout(
        this.#options.graph().get(`/${psid}`, { token, query: { fields: 'first_name,last_name' } }),
        this.#options.profileTimeoutMs ?? PROFILE_TIMEOUT_MS,
      );
      if (body === TIMED_OUT) {
        this.#options.log.warn({ accountId: account.id }, 'messenger profile read timed out');
        return null;
      }
      return fullName(parseGraph(messengerProfileSchema, body, 'a profile', token));
    } catch (error) {
      if (error instanceof GraphApiFailure) {
        // The class and the code, which is Meta's and not the customer's.
        this.#options.log.info(
          { accountId: account.id, kind: error.kind, code: error.code },
          'messenger profile not available',
        );
        return null;
      }
      throw error;
    }
  }

  // ----------------------------------------------------------------- echoes

  /**
   * A message the Page sent. Helpdock's own are in the thread already as the
   * reply an agent wrote; one typed in Meta Business Suite is not imported (an
   * accepted gap), but is counted so an operator can see it happens.
   */
  async #echo({ tx, account }: MetaEventContext, event: Event<'echo'>): Promise<MetaEventOutcome> {
    if (await this.#isOurs(tx, account, event)) {
      return ignored('echo');
    }
    this.#options.log.info(
      { accountId: account.id },
      'messenger echo of a message Helpdock did not send; dropped',
    );
    return ignored('echo-not-ours');
  }

  async #isOurs(
    tx: DbTransaction,
    account: MetaAccountRow,
    event: Event<'echo'>,
  ): Promise<boolean> {
    const appId = await this.#options.app.appId();
    if (appId !== '' && event.appId === appId) {
      return true;
    }
    if (event.metadata !== null && UUID.test(event.metadata)) {
      const delivery = await this.#options.repository.delivery(tx, event.metadata);
      return delivery?.accountId === account.id;
    }
    return false;
  }

  // --------------------------------------------------------------- receipts

  /**
   * `delivery` and `read` (DOMAIN-RULES §4.8): a watermark marks every delivery
   * of this conversation sent at or before it, and the `mids` a delivery names
   * are exact. Both only move a delivery forward.
   */
  async #receipt(
    { tx, account, now }: MetaEventContext,
    event: Event<'delivery'> | Event<'read'>,
    status: 'delivered' | 'read',
  ): Promise<MetaEventOutcome> {
    const { repository } = this.#options;
    const conversation = await repository.conversation(tx, account.id, event.customerId);
    if (conversation === undefined) {
      return ignored('no-conversation');
    }

    const mids = event.kind === 'delivery' ? event.mids : [];
    if (event.watermark === null && mids.length === 0) {
      return ignored('empty-receipt');
    }
    if (event.watermark !== null) {
      await repository.advanceByWatermark(tx, conversation.id, status, event.watermark);
    }
    for (const mid of mids) {
      await repository.advanceStatus(tx, mid, status, event.watermark ?? event.timestamp ?? now);
    }
    return HANDLED;
  }

  // ------------------------------------------------------- lines in a thread

  async #reaction(context: MetaEventContext, event: Event<'reaction'>): Promise<MetaEventOutcome> {
    const thread = await ticketOfMessage(context.tx, context.account, event.messageId);
    if (thread === undefined) {
      return ignored('unknown-message');
    }
    const locale = await this.#localeOf(context, event.customerId);
    const t = metaText(locale);
    const text =
      event.action === 'unreact'
        ? t('thread.reactionRemoved')
        : event.emoji === null
          ? t('thread.reactionPlain')
          : t('thread.reaction', { emoji: event.emoji });

    return this.#writeLine(context, thread, {
      text,
      // A reaction has no id of its own: who, to what, which way and when.
      key:
        event.timestamp === null
          ? null
          : `reaction:${event.messageId}:${event.customerId}:${event.action}:${String(event.timestamp.getTime())}`,
    });
  }

  async #edit(context: MetaEventContext, event: Event<'edit'>): Promise<MetaEventOutcome> {
    const thread = await ticketOfMessage(context.tx, context.account, event.messageId);
    if (thread === undefined) {
      return ignored('unknown-message');
    }
    if (event.text.trim() === '') {
      return ignored('empty-edit');
    }
    const locale = await this.#localeOf(context, event.customerId);
    const version = event.editNumber ?? event.timestamp?.getTime() ?? null;

    return this.#writeLine(context, thread, {
      text: metaText(locale)('thread.edited', { text: event.text }),
      key: version === null ? null : `edit:${event.messageId}:${String(version)}`,
    });
  }

  /** Something Meta says it sent that Helpdock cannot show: a line where the conversation is. */
  async #unsupported(
    context: MetaEventContext,
    event: Event<'unsupported'>,
  ): Promise<MetaEventOutcome> {
    const { tx, account } = context;
    if (event.customerId === null) {
      return ignored('no-customer');
    }
    const conversation = await this.#options.repository.conversation(
      tx,
      account.id,
      event.customerId,
    );
    const found =
      conversation?.ticketId == null
        ? undefined
        : await this.#options.tickets.findTicket(tx, conversation.ticketId);
    if (conversation === undefined || found === undefined) {
      return ignored('no-ticket');
    }
    const locale = await this.#options.lifecycleReads.localeForContact(
      tx,
      account.brandId,
      conversation.contactId,
    );

    return this.#writeLine(
      context,
      { ticketId: found.ticket.id, departmentId: found.ticket.departmentId },
      {
        text: metaText(locale)('thread.unsupported'),
        key: event.messageId === null ? null : `unsupported:${event.messageId}`,
      },
    );
  }

  async #writeLine(
    { tx, account }: MetaEventContext,
    thread: ThreadRef,
    line: SystemLine,
  ): Promise<MetaEventOutcome> {
    if (
      line.key !== null &&
      (await metaMessageSeen(tx, account.brandId, account.platform, line.key))
    ) {
      return { outcome: 'duplicate' };
    }
    await writeSystemLine(this.#options.tickets, tx, account, thread, line);
    return HANDLED;
  }

  // ----------------------------------------------------------------- policy

  /**
   * Meta warned, blocked or unblocked the Page. Nothing to file, but an operator
   * has to see it on Channels › Meta: it goes on the account as `last_error`.
   * An `unblock` is good news and is not an error.
   */
  async #policy(
    { tx, account, now }: MetaEventContext,
    event: Event<'policy_enforcement'>,
  ): Promise<MetaEventOutcome> {
    if (event.action?.toLowerCase() !== 'unblock') {
      const detail = [event.action, event.reason].filter((part) => part !== null).join(': ');
      await this.#options.repository.markError(
        tx,
        account.id,
        `messaging_policy_enforcement${detail === '' ? '' : ` ${detail}`}`,
        // The route stamps `last_event_at` with `now` after the handlers run, and health
        // reads an error as current only when it is later than the last event.
        new Date(now.getTime() + 1),
      );
    }
    return ignored('policy-enforcement');
  }

  // ---------------------------------------------------------------- lookups

  /** The contact's language for a line written about them. */
  async #localeOf({ tx, account }: MetaEventContext, customerId: string): Promise<Locale> {
    const conversation = await this.#options.repository.conversation(tx, account.id, customerId);
    return this.#options.lifecycleReads.localeForContact(
      tx,
      account.brandId,
      conversation?.contactId ?? null,
    );
  }
}
