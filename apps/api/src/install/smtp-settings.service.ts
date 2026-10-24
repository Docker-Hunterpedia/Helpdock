import { SmtpEmailSender } from '@helpdock/channels';
import { type Settings, settingDefinitions } from '@helpdock/config';
import { auditLog, INSTALL_SCOPE_BRAND_ID, users } from '@helpdock/db';
import type {
  SmtpSettings,
  SmtpSettingsTestRequest,
  SmtpSettingsUpdate,
  SmtpTestResult,
} from '@helpdock/schemas';
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { principalIdOf } from '../auth/principal.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import type { Logger } from '../logging/logger.js';
import { systemSenderConfigured } from '../notifications/install-channels.js';
import { SETUP_SMTP_TEST_IP_RULE, type SmtpTesterFactory } from './setup.service.js';
import { renderSmtpTestEmail } from './setup-email.js';
import { SetupFailure, SetupThrottled } from './setup-failure.js';

/**
 * The install's system sender, after setup (#369): the `smtp.*` settings the
 * first-run wizard writes, readable and writable by an install admin from
 * Admin › System › Outgoing email.
 *
 * The rules it keeps:
 *
 * - **The password is write-only.** It is a secret setting, encrypted at rest;
 *   `read` says whether one is stored and nothing more, and no audit row
 *   carries a value.
 * - **The environment wins.** A key pinned with `HD_SMTP_*` is reported locked,
 *   and a save that would change one is refused, as `InstallSettingsService`
 *   refuses a pinned OAuth key (ARCHITECTURE §4): storing a value nothing
 *   reads would look like a setting while being a lie.
 * - **The stored password stays with its server.** It is used, by a save or a
 *   test, only while host, port and user are what is stored; pointing the card
 *   at another server needs the password typed again
 *   (`smtp-password-required`). Otherwise a stolen install-admin session could
 *   mail the relay's credential to a host of its choosing.
 * - **The test sends with what is on screen**, so a save is not needed to try
 *   a change, and to the admin's own address, as the wizard step does. One
 *   transport per attempt, closed whatever happened.
 *
 * The worker reads these settings again when it sends, so a change here takes
 * effect without a restart (`install-channels.ts`).
 */

/** A `smtp.*` setting key, as the registry spells it. */
type SmtpKey =
  | 'smtp.host'
  | 'smtp.port'
  | 'smtp.tls'
  | 'smtp.user'
  | 'smtp.password'
  | 'smtp.from'
  | 'smtp.fromName';

/** The field of the read model each key answers for. */
const FIELD_OF: Readonly<Record<SmtpKey, keyof SmtpSettings['locked']>> = {
  'smtp.host': 'host',
  'smtp.port': 'port',
  'smtp.tls': 'tls',
  'smtp.user': 'user',
  'smtp.password': 'password',
  'smtp.from': 'fromAddress',
  'smtp.fromName': 'fromName',
};

export interface SmtpSettingsServiceOptions {
  readonly settings: Settings;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  /** Replaced by the unit suite, which has no relay to talk to. */
  readonly smtp?: SmtpTesterFactory;
}

export class SmtpSettingsService {
  readonly #settings: Settings;
  readonly #limiter: RateLimiter;
  readonly #logger: Logger;
  readonly #smtp: SmtpTesterFactory;

  constructor({
    settings,
    limiter,
    logger,
    smtp = (options) => new SmtpEmailSender(options),
  }: SmtpSettingsServiceOptions) {
    this.#settings = settings;
    this.#limiter = limiter;
    this.#logger = logger;
    this.#smtp = smtp;
  }

  /** What the card draws. Never the password. */
  async read(): Promise<SmtpSettings> {
    const [host, port, tls, user, password, fromAddress, fromName] = await Promise.all([
      this.#settings.get('smtp.host'),
      this.#settings.get('smtp.port'),
      this.#settings.get('smtp.tls'),
      this.#settings.get('smtp.user'),
      this.#settings.get('smtp.password'),
      this.#settings.get('smtp.from'),
      this.#settings.get('smtp.fromName'),
    ]);

    return {
      configured: systemSenderConfigured(host, fromAddress),
      host,
      port,
      tls,
      user,
      passwordConfigured: password !== '',
      fromAddress,
      fromName,
      locked: {
        host: this.#settings.isLockedByEnv('smtp.host'),
        port: this.#settings.isLockedByEnv('smtp.port'),
        tls: this.#settings.isLockedByEnv('smtp.tls'),
        user: this.#settings.isLockedByEnv('smtp.user'),
        password: this.#settings.isLockedByEnv('smtp.password'),
        fromAddress: this.#settings.isLockedByEnv('smtp.from'),
        fromName: this.#settings.isLockedByEnv('smtp.fromName'),
      },
    };
  }

  /**
   * Writes the keys that changed and are not pinned. The reply is the state
   * after the save, so a client always draws what is really stored.
   */
  async save(update: SmtpSettingsUpdate): Promise<SmtpSettings> {
    const before = await this.read();
    const principal = requireRequestContext().principal;
    if (principal === null) {
      throw new Error('An outgoing email settings route ran without a principal');
    }
    const actorId = principalIdOf(principal);

    // The stored values the update can be compared against. The password is
    // not among them: it cannot be read back, so providing one is the change.
    const stored = new Map<SmtpKey, string | number>([
      ['smtp.host', before.host],
      ['smtp.port', before.port],
      ['smtp.tls', before.tls],
      ['smtp.user', before.user],
      ['smtp.from', before.fromAddress],
      ['smtp.fromName', before.fromName],
    ]);

    const desired = new Map<SmtpKey, string | number>([
      ['smtp.host', update.host],
      ['smtp.port', update.port],
      ['smtp.tls', update.tls],
      ['smtp.user', update.user],
      ['smtp.from', update.fromAddress],
      ['smtp.fromName', update.fromName],
      ...(update.password === undefined ? [] : ([['smtp.password', update.password]] as const)),
    ]);

    const changed = [...desired].filter(([key, value]) => value !== stored.get(key));
    for (const [key] of changed) {
      if (before.locked[FIELD_OF[key]]) {
        throw new ConflictException(`${settingDefinitions[key].envKey} locks this setting`);
      }
    }

    const serverChanged =
      update.host !== before.host ||
      update.port !== before.port ||
      update.tls !== before.tls ||
      update.user !== before.user;
    if (serverChanged && before.passwordConfigured && update.password === undefined) {
      throw new SetupFailure('smtp-password-required');
    }

    if (changed.length > 0) {
      for (const [key, value] of changed) {
        await this.#settings.set(key, value as never, { updatedBy: actorId });
      }

      await getTx()
        .insert(auditLog)
        .values({
          brandId: INSTALL_SCOPE_BRAND_ID,
          actorType: principal.type,
          actorId,
          action: 'settings.updated',
          targetType: 'settings',
          targetId: 'smtp',
          // Which keys changed, and which the environment pins. A value never
          // is: one of these keys is a secret (REQUIREMENTS §5.1).
          meta: { keys: changed.map(([key]) => key) },
        });

      this.#logger.info({ keys: changed.map(([key]) => key) }, 'Outgoing email settings saved');
    }

    return this.read();
  }

  /**
   * Sends one message with the credentials on screen — the stored password
   * when the form holds none — to the admin who clicked. Answers with the
   * outcome rather than throwing, because "the relay refused the password" is
   * a result the card draws inline.
   */
  async test(input: SmtpSettingsTestRequest, ip: string): Promise<SmtpTestResult> {
    const principal = requireRequestContext().principal;
    if (principal === null) {
      throw new Error('An outgoing email settings route ran without a principal');
    }
    const userId = principalIdOf(principal);

    // Before the budget is spent: a refusal here costs no socket.
    const password = await this.#passwordFor(input);
    if (!(await this.#limiter.consume(SETUP_SMTP_TEST_IP_RULE, ip))) {
      throw new SetupThrottled(
        'Too many test emails from this address; try again later',
        await this.#limiter.retryAfter(SETUP_SMTP_TEST_IP_RULE, ip),
      );
    }

    const admin = await getTx()
      .select({ name: users.name, email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const recipient = admin[0];
    if (recipient === undefined) {
      // The account went away while the page was open. Nothing left to do.
      throw new ConflictException('This account no longer exists');
    }

    const sender = this.#smtp({
      host: input.host,
      port: input.port,
      tls: input.tls,
      user: input.user,
      password,
      fromAddress: input.fromAddress,
      fromName: input.fromName,
    });

    try {
      const result = await sender.test(
        renderSmtpTestEmail({
          to: recipient.email,
          name: recipient.name,
          host: input.host,
          locale: recipient.locale,
        }),
      );

      this.#logger.info(
        { host: input.host, port: input.port, tls: input.tls, delivered: result.delivered },
        'Outgoing email test attempted',
      );

      return { ...result, recipient: recipient.email };
    } finally {
      // One transport per attempt, closed whatever happened, so a wrong host
      // does not leave a socket behind for every retry.
      sender.close();
    }
  }

  /**
   * The password a test sends: the one typed, else the stored one, and the
   * stored one only to the server it was saved for.
   */
  async #passwordFor(input: SmtpSettingsTestRequest): Promise<string> {
    if (input.password !== undefined) {
      return input.password;
    }

    const [host, port, tls, user, password] = await Promise.all([
      this.#settings.get('smtp.host'),
      this.#settings.get('smtp.port'),
      this.#settings.get('smtp.tls'),
      this.#settings.get('smtp.user'),
      this.#settings.get('smtp.password'),
    ]);
    if (
      password !== '' &&
      (input.host !== host || input.port !== port || input.tls !== tls || input.user !== user)
    ) {
      throw new SetupFailure('smtp-password-required');
    }

    return password;
  }
}
