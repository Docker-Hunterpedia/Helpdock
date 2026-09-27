import {
  type ChannelAdapter,
  ChannelCapabilityError,
  type ChannelHealth,
  type InboundMessage,
  type SendResult,
} from '../adapter.js';
import { SanitizeLimitError } from '../html/sanitize.js';
import { type ProcessedBody, processEmailBody } from './inbound/body.js';
import {
  type AutomatedReason,
  authenticationFailed,
  automatedReason,
  threadHintsOf,
} from './inbound/classify.js';
import type { InboundEnvelope, MailAddress } from './inbound/inbound-email.js';

/**
 * The email channel's {@link ChannelAdapter} (M2-01). Inbound it turns an
 * {@link InboundEnvelope} — from IMAP or any inbound-parse provider — into the
 * one message shape the router reads, with the email-only facts beside it.
 *
 * `send` belongs to M2-05, which delivers through the outbox with Nodemailer;
 * until that lands on this adapter it refuses rather than pretending.
 */

/** What only email knows, carried beside the channel-neutral message. */
export interface EmailFacts {
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly date: Date | null;
  readonly body: ProcessedBody;
  /** Why the message is automated, or null when a person sent it (DOMAIN-RULES §4.3). */
  readonly automated: AutomatedReason | null;
  /** An SPF or DKIM failure was reported (M2-07). */
  readonly authFailed: boolean;
  readonly recipients: readonly string[];
}

export interface EmailInboundMessage extends InboundMessage {
  readonly email: EmailFacts;
}

/** A message with no usable sender cannot be answered and is not a ticket. */
export class MissingSenderError extends Error {
  constructor() {
    super('The message has no From address');
    this.name = 'MissingSenderError';
  }
}

/**
 * The body, or — for a body built to be expensive to sanitise — its text. Mail
 * is not a request that can be answered 400; a newsletter nested past
 * `MAX_TAGS` still deserves to be read, just not as HTML.
 */
const bodyOf = (html: string | null, text: string | null): ProcessedBody => {
  try {
    return processEmailBody({ html, text });
  } catch (error) {
    if (error instanceof SanitizeLimitError) {
      return processEmailBody({ html: null, text: text ?? '' });
    }
    throw error;
  }
};

export const toEmailInboundMessage = (
  envelope: InboundEnvelope,
  receivedAt: Date,
): EmailInboundMessage => {
  const { email } = envelope;
  if (email.from === null || email.from.address === '') {
    throw new MissingSenderError();
  }

  const body = bodyOf(email.html, email.text);

  return {
    channel: 'email',
    externalId: email.messageId,
    from: { kind: 'email', value: email.from.address, name: email.from.name },
    cc: [...email.to, ...email.cc].map((address) => ({
      kind: 'email' as const,
      value: address.address,
      name: address.name,
    })),
    subject: email.subject,
    bodyHtml: body.html,
    files: email.attachments,
    hints: threadHintsOf(email),
    receivedAt,
    email: {
      to: email.to,
      cc: email.cc,
      date: email.date,
      body,
      automated: automatedReason(email),
      authFailed: authenticationFailed(email),
      recipients: envelope.recipients,
    },
  };
};

export class EmailChannelAdapter implements ChannelAdapter<InboundEnvelope, unknown> {
  readonly kind = 'email' as const;
  readonly #now: () => Date;

  constructor({ now = () => new Date() }: { readonly now?: () => Date } = {}) {
    this.#now = now;
  }

  /** Pollers are BullMQ job schedulers owned by the worker (`email.poll`), not by the adapter. */
  async init(): Promise<void> {
    await Promise.resolve();
  }

  async handleInbound(envelope: InboundEnvelope): Promise<EmailInboundMessage> {
    await Promise.resolve();
    return toEmailInboundMessage(envelope, this.#now());
  }

  send(): Promise<SendResult> {
    return Promise.reject(new ChannelCapabilityError('email', 'send before M2-05'));
  }

  /** A mailbox's health is read from its row (`mailboxHealth` in `@helpdock/schemas`). */
  async health(): Promise<ChannelHealth> {
    await Promise.resolve();
    return { state: 'healthy', detail: null };
  }
}
