import { type EmailMessage, SmtpEmailSender } from '@helpdock/channels';
import { decryptSecret, type Keyring, type Settings } from '@helpdock/config';
import type { EmailOutboundSettings } from '@helpdock/db';
import { type EmailSender, type SmtpCredentials, smtpTlsModeSchema } from '@helpdock/schemas';

/**
 * Which SMTP server a brand's mail goes through, and the seam a test replaces
 * it at.
 *
 * A brand's own server (Channels › Outgoing email) wins; without one, the
 * install's `smtp.*` settings the first-run wizard wrote. Both are operator
 * configuration, not user input, so neither goes through the SSRF-safe client
 * — the reason `SmtpEmailSender` gives.
 */

/** The server half of `SmtpCredentials`; the sender is per message (`EmailMessage.from`). */
export type SmtpServer = Omit<SmtpCredentials, 'fromAddress' | 'fromName'>;

export interface SmtpTransport {
  send(message: EmailMessage): Promise<void>;
  close(): void;
}

/**
 * Builds one transport per send or test. Nodemailer's pool is not worth
 * keeping between jobs: a brand's credentials can change between two of them,
 * and a queued send is not latency-bound.
 */
export type SmtpTransportFactory = (server: SmtpServer, from: EmailSender) => SmtpTransport;

export const smtpTransportFactory: SmtpTransportFactory = (server, from) =>
  new SmtpEmailSender({
    ...server,
    fromAddress: from.address,
    fromName: from.name || from.address,
  });

/** The install's server and sender, as the wizard stored them. */
export interface InstallSmtp {
  read(): Promise<{ server: SmtpServer; from: EmailSender | undefined } | undefined>;
}

export class SettingsInstallSmtp implements InstallSmtp {
  readonly #settings: Pick<Settings, 'get'>;

  constructor(settings: Pick<Settings, 'get'>) {
    this.#settings = settings;
  }

  async read(): Promise<{ server: SmtpServer; from: EmailSender | undefined } | undefined> {
    const host = await this.#settings.get('smtp.host');
    if (host === '') {
      return undefined;
    }
    const address = await this.#settings.get('smtp.from');

    return {
      server: {
        host,
        port: await this.#settings.get('smtp.port'),
        tls: await this.#settings.get('smtp.tls'),
        user: await this.#settings.get('smtp.user'),
        password: await this.#settings.get('smtp.password'),
      },
      from:
        address === '' ? undefined : { address, name: await this.#settings.get('smtp.fromName') },
    };
  }
}

/** A brand's own server from its row, the password decrypted; undefined when it has none. */
export const brandSmtpServer = (
  row: EmailOutboundSettings | undefined,
  keyring: Keyring,
): SmtpServer | undefined => {
  if (row?.smtpHost == null || row.smtpPort == null) {
    return undefined;
  }
  const tls = smtpTlsModeSchema.safeParse(row.smtpTls);

  return {
    host: row.smtpHost,
    port: row.smtpPort,
    tls: tls.success ? tls.data : 'starttls',
    user: row.smtpUser ?? '',
    password:
      row.smtpPassword == null || row.smtpPassword === ''
        ? ''
        : decryptSecret(row.smtpPassword, keyring),
  };
};
