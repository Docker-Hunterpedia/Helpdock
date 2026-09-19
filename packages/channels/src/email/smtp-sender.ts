import type { SmtpCredentials, SmtpTestResult } from '@helpdock/schemas';
import { SMTP_RESPONSE_MAX_LENGTH } from '@helpdock/schemas';
import { createTransport, type SMTPSentMessageInfo, type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from './sender.js';
import { classifySmtpError, SmtpTimeoutError } from './smtp-errors.js';

/**
 * The smallest real SMTP transport: enough for the first-run wizard to prove
 * that the credentials an operator typed actually reach their relay.
 *
 * M2 owns outbound email properly — per-brand credentials, the `email.send`
 * job, a deterministic `Message-ID` per ticket message, retries and a DLQ. What
 * is here is the transport alone, behind the same `EmailSender` interface the
 * auth mails already use, so M2 extends it rather than replacing it.
 *
 * **The host is not run through the SSRF-safe client.** That client exists for
 * URLs a *visitor* supplies (DOMAIN-RULES §13); an SMTP host is operator
 * configuration, like `DATABASE_URL`, and a self-hosted install's relay is very
 * often on the private network beside it — `mailpit:1025` on the Compose
 * network is the documented development setup and the integration test's
 * fixture. Blocking private ranges here would break the ordinary case to
 * inconvenience somebody who already owns the install.
 */

/** Every timer, so a wrong host cannot hold the wizard's request open. */
export const SMTP_TIMEOUT_MS = 10_000;

export interface SmtpEmailSenderOptions extends SmtpCredentials {
  /** Overridden by the tests; production uses {@link SMTP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * How a TLS mode becomes Nodemailer's three flags, and how the deadline becomes
 * its four timers. Exported because this mapping is the whole of the transport's
 * behaviour that does not need a server to observe.
 */
export const smtpTransportOptions = ({
  host,
  port,
  tls,
  user,
  password,
  timeoutMs = SMTP_TIMEOUT_MS,
}: SmtpEmailSenderOptions) => ({
  host,
  port,
  // Implicit TLS from the first byte. `starttls` and `none` both open in the
  // clear; `requireTLS` is what makes the first of them refuse to continue on a
  // server that will not upgrade, rather than sending the password anyway.
  secure: tls === 'tls',
  requireTLS: tls === 'starttls',
  ignoreTLS: tls === 'none',
  ...(user === '' ? {} : { auth: { user, pass: password } }),
  connectionTimeout: timeoutMs,
  greetingTimeout: timeoutMs,
  socketTimeout: timeoutMs,
  dnsTimeout: timeoutMs,
  // Nodemailer's defaults are minutes long, which is the right answer for a
  // queued send and the wrong one for a person waiting on a form.
});

/** A relay's reply is arbitrary text; it is shown, so it is bounded. */
const truncateResponse = (response: string): string =>
  response.trim().slice(0, SMTP_RESPONSE_MAX_LENGTH);

export class SmtpEmailSender implements EmailSender {
  readonly #options: SmtpEmailSenderOptions;
  readonly #transporter: Transporter<SMTPSentMessageInfo>;

  constructor(options: SmtpEmailSenderOptions) {
    this.#options = options;
    this.#transporter = createTransport(smtpTransportOptions(options));
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#deliver(message);
  }

  /**
   * Sends and reports, instead of throwing: the wizard draws the outcome
   * inline, and "the server said 250" is as much a result as a refusal.
   */
  async test(message: EmailMessage): Promise<SmtpTestResult> {
    try {
      const response = await this.#deliver(message);

      return response === undefined ? { delivered: true } : { delivered: true, response };
    } catch (error) {
      return { delivered: false, error: classifySmtpError(error) };
    }
  }

  /** Closes the pool. One instance per attempt, so nothing is left connected. */
  close(): void {
    this.#transporter.close();
  }

  async #deliver(message: EmailMessage): Promise<string | undefined> {
    const { fromAddress, fromName, timeoutMs = SMTP_TIMEOUT_MS } = this.#options;

    // Nodemailer's own timers cover the connection, the greeting and socket
    // inactivity; this covers the whole conversation, so a relay that answers
    // every command slowly still cannot hold the request past the deadline.
    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SmtpTimeoutError());
      }, timeoutMs);
      timer.unref?.();
    });

    const info = await Promise.race([
      this.#transporter.sendMail({
        from: { address: fromAddress, name: fromName },
        to: { address: message.to.address, name: message.to.name ?? '' },
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      deadline,
    ]);

    return typeof info.response === 'string' ? truncateResponse(info.response) : undefined;
  }
}
