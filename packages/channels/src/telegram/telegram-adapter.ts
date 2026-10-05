import {
  type ChannelAdapter,
  ChannelCapabilityError,
  type ChannelHealth,
  type InboundFile,
  type InboundMessage,
  type SendResult,
} from '../adapter.js';
import { paragraphsToHtml } from '../email/customer-layout.js';
import { sanitizeMessageBody } from '../html/text.js';
import { locationText } from './render.js';
import type { TelegramEvent, TelegramPoint } from './update.js';

/**
 * The Telegram channel's {@link ChannelAdapter} (M6-01). Inbound it turns a
 * classified message and the files already fetched for it into the one
 * message shape the api files, with the Telegram-only facts beside it.
 *
 * Sending is the `telegram.send` job's, through the outbox, as email's is the
 * `email.send` job's; the adapter does not pretend to.
 */

export type TelegramMessageEvent = Extract<TelegramEvent, { kind: 'message' }>;

/** What only Telegram knows, carried beside the channel-neutral message. */
export interface TelegramFacts {
  readonly chatId: string;
  readonly messageId: number;
  readonly location: TelegramPoint | null;
  readonly username: string | null;
}

export interface TelegramInboundMessage extends InboundMessage {
  readonly telegram: TelegramFacts;
  /** The same message as text, for `ticket_messages.body_text`. */
  readonly bodyText: string;
}

export interface TelegramInboundInput {
  readonly event: TelegramMessageEvent;
  /** The bot's own Telegram id: a message id is unique per chat, and a chat per bot. */
  readonly botTelegramId: number;
  readonly files: readonly InboundFile[];
  /** "Location" in the contact's language. */
  readonly locationLabel: string;
}

/**
 * The dedupe key of DOMAIN-RULES §6 for one Telegram message. A redelivered
 * webhook or a poll that saw the update again lands on the same key.
 */
export const telegramExternalId = (
  botTelegramId: number,
  chatId: string,
  messageId: number,
): string => `${String(botTelegramId)}:${chatId}:${String(messageId)}`;

export const toTelegramInboundMessage = (
  input: TelegramInboundInput,
  receivedAt: Date,
): TelegramInboundMessage => {
  const { event } = input;
  const text = [
    event.text,
    ...(event.location === null ? [] : [locationText(event.location, input.locationLabel)]),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  const body = sanitizeMessageBody(paragraphsToHtml(text));

  return {
    channel: 'telegram',
    externalId: telegramExternalId(input.botTelegramId, event.sender.chatId, event.messageId),
    from: { kind: 'telegram', value: event.sender.chatId, name: event.sender.name },
    cc: [],
    subject: '',
    bodyHtml: body.html,
    bodyText: body.text,
    files: input.files,
    hints: { messageIds: [], ticketNumbers: [] },
    receivedAt,
    telegram: {
      chatId: event.sender.chatId,
      messageId: event.messageId,
      location: event.location,
      username: event.sender.username,
    },
  };
};

export class TelegramChannelAdapter implements ChannelAdapter<TelegramInboundInput, unknown> {
  readonly kind = 'telegram' as const;
  readonly #now: () => Date;

  constructor({ now = () => new Date() }: { readonly now?: () => Date } = {}) {
    this.#now = now;
  }

  /** The webhook is registered by "Set webhook"; polling is the worker's `telegram.poll`. */
  async init(): Promise<void> {
    await Promise.resolve();
  }

  async handleInbound(input: TelegramInboundInput): Promise<TelegramInboundMessage> {
    await Promise.resolve();
    return toTelegramInboundMessage(input, this.#now());
  }

  send(): Promise<SendResult> {
    return Promise.reject(new ChannelCapabilityError('telegram', 'send outside the outbox'));
  }

  /** A bot's health is read from its row (`telegramBotHealth` in `@helpdock/schemas`). */
  async health(): Promise<ChannelHealth> {
    await Promise.resolve();
    return { state: 'healthy', detail: null };
  }
}
