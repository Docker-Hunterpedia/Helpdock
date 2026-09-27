/**
 * The one interface every channel implements (ARCHITECTURE §8, REQUIREMENTS
 * §4.4: "normalize inbound → message; render outbound; identity mapping;
 * health check"). M2 ships the email adapter; M4's widget and form, M6's
 * Telegram and M8's API implement the same shape, and so will v1.1's WhatsApp
 * and Slack without the router learning anything new.
 *
 * The adapter only *translates*. Deciding which contact a message is from,
 * which ticket it belongs to and whether it may thread there at all is the
 * `ConversationRouter`'s (`apps/api/src/channels/conversation-router.ts`),
 * because those are DOMAIN-RULES §4 decisions and must be made once, the same
 * way, for every channel.
 */

/** ARCHITECTURE §8's list. The v1.1 names are reserved, not implemented. */
export type ChannelKind =
  | 'email'
  | 'telegram'
  | 'widget'
  | 'form'
  | 'api'
  | 'whatsapp'
  | 'messenger'
  | 'instagram'
  | 'slack'
  | 'discord';

/**
 * Who a message is from, in the vocabulary of `contact_identities`. `verified`
 * is decided by the router from the channel, never by the adapter: the adapter
 * says where the identifier came from, and DOMAIN-RULES §4.4 says what that is
 * worth.
 */
export interface InboundIdentity {
  readonly kind: 'email' | 'telegram' | 'visitor' | 'external' | 'phone';
  readonly value: string;
  readonly name: string | null;
}

/** A file that arrived with a message, not yet stored anywhere. */
export interface InboundFile {
  readonly filename: string;
  /** As the sender declared it. The media pipeline sniffs the bytes and decides. */
  readonly contentType: string;
  readonly content: Buffer;
  /**
   * The `Content-ID` of a part the body refers to with `cid:`, without angle
   * brackets. Null for an ordinary attachment.
   */
  readonly contentId: string | null;
  /** Referenced from the body rather than attached beside it. */
  readonly inline: boolean;
}

/**
 * What the message says about where it belongs. Hints, never proof
 * (DOMAIN-RULES §4: "an identifier someone types is a hint").
 */
export interface ThreadHints {
  /** Message ids this one answers, from `In-Reply-To` and `References`. */
  readonly messageIds: readonly string[];
  /** `[PREFIX-N]` tokens in the subject, as `{ prefix, number }`. */
  readonly ticketNumbers: readonly { readonly prefix: string; readonly number: number }[];
}

/**
 * A message in the one shape every channel produces. `body` is untrusted HTML:
 * the router sanitises it on the way into `ticket_messages`, as every writer
 * of that table does.
 */
export interface InboundMessage {
  readonly channel: ChannelKind;
  /** The channel's own id for the message: the dedupe key of DOMAIN-RULES §6. */
  readonly externalId: string;
  readonly from: InboundIdentity;
  /** Other people the message was addressed to, who become CC participants (§2.5). */
  readonly cc: readonly InboundIdentity[];
  readonly subject: string;
  readonly bodyHtml: string;
  readonly files: readonly InboundFile[];
  readonly hints: ThreadHints;
  readonly receivedAt: Date;
}

/** What a send produced. M2-05 fills this in for email; M6 for Telegram. */
export interface SendResult {
  /** The channel's id for what was sent, recorded for threading. */
  readonly externalId: string;
}

/** A message to deliver, already rendered for the channel by its caller. */
export interface OutboundMessage {
  readonly brandId: string;
  readonly ticketMessageId: string;
}

export interface ChannelHealth {
  readonly state: 'healthy' | 'behind' | 'failing' | 'waiting';
  /** What the other side answered the last time it failed, verbatim. */
  readonly detail: string | null;
}

export interface ChannelAdapter<TRaw = unknown, TConfig = unknown> {
  readonly kind: ChannelKind;
  /** Start whatever the channel needs to receive: a poller, a webhook registration. */
  init(config: TConfig): Promise<void>;
  /** Normalises one raw inbound item. Throws when it is not a message at all. */
  handleInbound(raw: TRaw): Promise<InboundMessage>;
  send(message: OutboundMessage): Promise<SendResult>;
  health(): Promise<ChannelHealth>;
}

/** Thrown by an adapter asked to do something its milestone has not built yet. */
export class ChannelCapabilityError extends Error {
  constructor(kind: ChannelKind, capability: string) {
    super(`The ${kind} channel cannot ${capability} in this build`);
    this.name = 'ChannelCapabilityError';
  }
}
