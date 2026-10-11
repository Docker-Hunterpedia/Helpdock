import type { MetaFileRef, MetaPlatform } from '@helpdock/schemas';
import {
  type ChannelAdapter,
  ChannelCapabilityError,
  type ChannelHealth,
  type InboundMessage,
  type SendResult,
} from '../adapter.js';
import { paragraphsToHtml } from '../email/customer-layout.js';
import { sanitizeMessageBody } from '../html/text.js';
import { type MetaMessageEvent, metaExternalId, metaIdentityValue } from './envelope.js';
import { contactsText, metaLocationText, type StoryLabels, storyText } from './text.js';

/**
 * What the three Meta adapters share (M10-01): a classified customer message
 * and the words the api localises, turned into the one message shape every
 * channel files. The adapters only *translate*; which contact, which ticket and
 * whether the sender is blocked are the router's and the sender gate's, made
 * once for every channel (`apps/api/src/meta/`, M10-02 onward).
 */

/** What only Meta knows, carried beside the channel-neutral message. */
export interface MetaInboundFacts {
  readonly platform: MetaPlatform;
  /** The phone number id, the Page id or the Instagram account id the message came to. */
  readonly accountExternalId: string;
  readonly customerId: string;
  readonly messageId: string;
  /** The message this one answers, so the thread can quote it when it is on the ticket. */
  readonly quotedId: string | null;
  /** Files to fetch with `meta.media_fetch`; the message is filed without them. */
  readonly fileRefs: readonly MetaFileRef[];
  readonly profileName: string | null;
  readonly username: string | null;
  /** WhatsApp: the customer's number in digits, a verified phone when present. */
  readonly waId: string | null;
}

export interface MetaInboundMessage extends InboundMessage {
  readonly meta: MetaInboundFacts;
  /** The same message as text, for `ticket_messages.body_text`. */
  readonly bodyText: string;
}

/** The words a message is written with, in the contact's language (the `meta` catalog). */
export interface MetaInboundLabels {
  /** "Location". */
  readonly location: string;
  /** "Contact". */
  readonly contact: string;
  readonly story: StoryLabels;
}

export interface MetaInboundInput {
  readonly event: MetaMessageEvent;
  readonly accountExternalId: string;
  readonly labels: MetaInboundLabels;
}

/** The message's text, then what Meta sent that has no place in a text field, as text. */
const bodyTextOf = ({ event, labels }: MetaInboundInput): string =>
  [
    event.text,
    ...(event.location === null ? [] : [metaLocationText(event.location, labels.location)]),
    ...(event.contacts.length === 0 ? [] : [contactsText(event.contacts, labels.contact)]),
    ...(event.story === null ? [] : [storyText(event.story, labels.story)]),
    ...event.links.map((link) => (link.title === null ? link.url : `${link.title}\n${link.url}`)),
  ]
    .filter((part) => part !== '')
    .join('\n\n');

/** A customer's name for the contact: the profile name, else the `@handle`. */
const nameOf = (event: MetaMessageEvent): string | null =>
  event.profileName ?? (event.username === null ? null : `@${event.username}`);

export const toMetaInboundMessage = (
  platform: MetaPlatform,
  input: MetaInboundInput,
  receivedAt: Date,
): MetaInboundMessage => {
  const { event, accountExternalId } = input;
  if (event.platform !== platform) {
    throw new TypeError(`A ${event.platform} message was given to the ${platform} adapter`);
  }
  const body = sanitizeMessageBody(paragraphsToHtml(bodyTextOf(input)));

  return {
    channel: platform,
    externalId: metaExternalId(platform, event.messageId),
    from: {
      kind: platform,
      value: metaIdentityValue(platform, accountExternalId, event.customerId),
      name: nameOf(event),
    },
    cc: [],
    subject: '',
    bodyHtml: body.html,
    bodyText: body.text,
    // The files are fetched by a job after the message is filed (ADR 0025, 6).
    files: [],
    hints: { messageIds: [], ticketNumbers: [] },
    receivedAt,
    meta: {
      platform,
      accountExternalId,
      customerId: event.customerId,
      messageId: event.messageId,
      quotedId: event.quotedId,
      fileRefs: event.files,
      profileName: event.profileName,
      username: event.username,
      waId: event.waId,
    },
  };
};

/**
 * The {@link ChannelAdapter} of one Meta platform. Inbound it turns a classified
 * message into the shape the api files; sending is the `meta.send` job's,
 * through the outbox, as email's is the `email.send` job's, and the adapter
 * does not pretend to.
 */
export class MetaChannelAdapter implements ChannelAdapter<MetaInboundInput, unknown> {
  readonly kind: MetaPlatform;
  readonly #now: () => Date;

  constructor(kind: MetaPlatform, { now = () => new Date() }: { readonly now?: () => Date } = {}) {
    this.kind = kind;
    this.#now = now;
  }

  /** The webhook is registered in the Meta dashboard and "Subscribe now"; there is nothing to start. */
  async init(): Promise<void> {
    await Promise.resolve();
  }

  async handleInbound(input: MetaInboundInput): Promise<MetaInboundMessage> {
    await Promise.resolve();
    return toMetaInboundMessage(this.kind, input, this.#now());
  }

  send(): Promise<SendResult> {
    return Promise.reject(new ChannelCapabilityError(this.kind, 'send outside the outbox'));
  }

  /** An account's health is read from its row (`metaAccountHealth` in `@helpdock/schemas`). */
  async health(): Promise<ChannelHealth> {
    await Promise.resolve();
    return { state: 'healthy', detail: null };
  }
}
