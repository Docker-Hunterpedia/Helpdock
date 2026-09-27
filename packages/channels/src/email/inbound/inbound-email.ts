import { createHash } from 'node:crypto';
import type { InboundFile } from '../../adapter.js';

/**
 * One inbound email, however it arrived: fetched over IMAP (M2-02), or posted
 * by Postmark, SendGrid, Mailgun, Resend or anything speaking the generic JSON
 * shape (M2-03). Everything after this point — threading, sanitising, the
 * router — reads this and nothing provider-specific.
 */

export interface MailAddress {
  /** Lower-cased. Whether it is a valid address is the contact layer's to decide. */
  readonly address: string;
  readonly name: string | null;
}

export interface InboundEmail {
  /**
   * The `Message-ID`, without angle brackets. Synthesised from the content when
   * a message has none, because it is the dedupe key and a message without
   * one would otherwise be imported on every redelivery.
   */
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly from: MailAddress | null;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string;
  readonly date: Date | null;
  /** Untrusted. Sanitised by `processEmailBody`, never rendered as it is. */
  readonly html: string | null;
  readonly text: string | null;
  /** Header name (lower-case) to every value it had, in order. */
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly attachments: readonly InboundFile[];
}

/** What a transport hands over: the message, and every address it was delivered to. */
export interface InboundEnvelope {
  readonly email: InboundEmail;
  /**
   * The envelope recipients when the transport knows them, then `To` and `Cc`.
   * The first one that is a mailbox picks the brand; a `Bcc` to a mailbox is
   * only visible here.
   */
  readonly recipients: readonly string[];
}

/** `<abc@host>` → `abc@host`. Whitespace and folding are dropped too. */
export const bareMessageId = (value: string): string =>
  value.trim().replace(/^<+/, '').replace(/>+$/, '').replace(/\s+/g, '');

/** Every `<…>` id in a `References` or `In-Reply-To` value, in order. */
export const messageIdsIn = (value: string | null | undefined): string[] => {
  if (value === null || value === undefined) {
    return [];
  }

  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1] ?? '');
  const ids = bracketed.length > 0 ? bracketed : value.split(/\s+/);

  return ids.map(bareMessageId).filter((id) => id !== '');
};

/**
 * A stand-in `Message-ID` for a message that came without one. Deterministic,
 * so the same message delivered twice dedupes, and under `.invalid` (RFC 2606)
 * so it can never collide with an id a real server issued.
 */
export const synthesiseMessageId = (parts: {
  readonly from: string | null;
  readonly date: Date | null;
  readonly subject: string;
  readonly body: string;
}): string => {
  const digest = createHash('sha256')
    .update(
      [parts.from ?? '', parts.date?.toISOString() ?? '', parts.subject, parts.body].join('\n'),
    )
    .digest('hex')
    .slice(0, 40);

  return `${digest}@missing-message-id.invalid`;
};

export const lowerAddress = (address: string): string => address.trim().toLowerCase();

/** The first value of a header, or null. */
export const headerValue = (email: InboundEmail, name: string): string | null =>
  email.headers.get(name.toLowerCase())?.[0] ?? null;

/** The recipients of a message in the order {@link InboundEnvelope.recipients} promises. */
export const recipientsOf = (email: InboundEmail, envelope: readonly string[] = []): string[] => [
  ...new Set(
    [...envelope, ...email.to.map((to) => to.address), ...email.cc.map((cc) => cc.address)]
      .map(lowerAddress)
      .filter((address) => address !== ''),
  ),
];
