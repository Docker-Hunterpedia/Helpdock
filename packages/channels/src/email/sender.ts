/**
 * The seam between "something wants an email sent" and "SMTP happens".
 *
 * M0-05 needs to put a magic link and a password reset in front of a person,
 * M0-06 adds the staff invitation, and M2 is the milestone that brings
 * Nodemailer, per-brand SMTP credentials and the outbound queue. The interface
 * is declared here so M2 implements it without touching the services that send,
 * and so dev and test have something honest to run against in the meantime.
 *
 * Anything with a real transport belongs behind the outbox (DOMAIN-RULES §6).
 * These three are the documented exception: none is a domain change, each is
 * useless the moment its Redis token expires, and a queue that is not built yet
 * cannot carry them.
 */

export interface EmailAddress {
  readonly address: string;
  readonly name?: string;
}

export interface EmailMessage {
  readonly to: EmailAddress;
  readonly subject: string;
  /** Always present: a client that refuses HTML still has to be able to read it. */
  readonly text: string;
  readonly html: string;
  /** BCP 47 tag of the catalog the body was rendered from, for the log. */
  readonly locale: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Where {@link LoggingEmailSender} writes. One line per message, structured. */
export type EmailLog = (fields: Record<string, unknown>, message: string) => void;

/**
 * Writes the message to the log instead of sending it, and keeps the last ones
 * so a test can read what would have gone out.
 *
 * It logs the subject and the recipient, never the body: a magic-link body
 * contains a working credential, and a log is the one place it must not be
 * (REQUIREMENTS §5.1).
 */
export class LoggingEmailSender implements EmailSender {
  readonly #log: EmailLog;
  readonly #sent: EmailMessage[] = [];
  readonly #keep: number;

  constructor({ log, keep = 20 }: { readonly log: EmailLog; readonly keep?: number }) {
    this.#log = log;
    this.#keep = keep;
  }

  /** What was "sent", oldest first. Test scaffolding; empty in a real deploy. */
  get sent(): readonly EmailMessage[] {
    return this.#sent;
  }

  send(message: EmailMessage): Promise<void> {
    this.#sent.push(message);
    if (this.#sent.length > this.#keep) {
      this.#sent.shift();
    }

    this.#log(
      { to: message.to.address, subject: message.subject, locale: message.locale },
      'Email not sent: no transport is configured on this install (SMTP arrives with M2).',
    );

    return Promise.resolve();
  }
}
