import { type EmailSender, SmtpEmailSender } from '@helpdock/channels';
import type { Settings } from '@helpdock/config';
import type { DeliverySettings } from './delivery.js';
import type { VapidKeys } from './push.js';

/**
 * The two install-wide channels M3-07 depends on, read from settings at the
 * moment they are needed so an operator who fills them in later needs no
 * restart.
 *
 * - **The system sender** is the `smtp.*` settings the first-run wizard writes:
 *   the install's own address, the one sign-in links use. Staff notifications
 *   go from it and never from a brand's support mailbox, so a reply to one
 *   cannot land in a ticket (artboard `EmailStaffNotification`).
 * - **The VAPID key pair** is `push.vapidPublicKey` and `push.vapidPrivateKey`
 *   (ADR 0002), which `HD_PUSH_VAPID_PUBLIC_KEY` and `HD_PUSH_VAPID_PRIVATE_KEY`
 *   may pin. The private key is a secret setting: encrypted at rest, and never
 *   in a response — only the public key is served, as the browser's
 *   `applicationServerKey`.
 */
export class InstallChannels implements DeliverySettings {
  readonly #settings: Pick<Settings, 'get'>;

  constructor(settings: Pick<Settings, 'get'>) {
    this.#settings = settings;
  }

  async systemSender(): Promise<EmailSender | null> {
    const [host, port, tls, user, password, fromAddress, fromName] = await Promise.all([
      this.#settings.get('smtp.host'),
      this.#settings.get('smtp.port'),
      this.#settings.get('smtp.tls'),
      this.#settings.get('smtp.user'),
      this.#settings.get('smtp.password'),
      this.#settings.get('smtp.from'),
      this.#settings.get('smtp.fromName'),
    ]);
    if (host === '' || fromAddress === '') {
      return null;
    }

    const sender = new SmtpEmailSender({
      host,
      port,
      tls,
      user,
      password,
      fromAddress,
      fromName: fromName === '' ? 'Helpdock' : fromName,
    });

    return {
      send: async (message) => {
        try {
          await sender.send(message);
        } finally {
          sender.close();
        }
      },
    };
  }

  async vapidKeys(): Promise<VapidKeys | null> {
    const [publicKey, privateKey] = await Promise.all([
      this.#settings.get('push.vapidPublicKey'),
      this.#settings.get('push.vapidPrivateKey'),
    ]);

    return publicKey === '' || privateKey === '' ? null : { publicKey, privateKey };
  }

  /** The public half alone, for the preferences page. Null until both halves exist. */
  async vapidPublicKey(): Promise<string | null> {
    return (await this.vapidKeys())?.publicKey ?? null;
  }
}
