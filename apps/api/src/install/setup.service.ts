import type { EmailMessage } from '@helpdock/channels';
import { SmtpEmailSender, type SmtpEmailSenderOptions } from '@helpdock/channels';
import type { SettingKey, Settings, SettingValue } from '@helpdock/config';
import {
  auditLog,
  brandDomains,
  brands,
  type Db,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  userBrandRoles,
  users,
  uuidv7,
  withTenant,
} from '@helpdock/db';
import type {
  SetupAdminRequest,
  SetupAdminResponse,
  SetupBrandRequest,
  SetupBrandResponse,
  SetupCompleteResponse,
  SetupSmtpRequest,
  SetupSmtpResponse,
  SmtpCredentials,
  SmtpTestResult,
} from '@helpdock/schemas';
import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { PasswordHasher } from '../auth/password.js';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import type { IssuedSession, SessionService } from '../auth/session/session.service.js';
import type { Logger } from '../logging/logger.js';
import { readInstallState } from './install-state.js';
import { renderSmtpTestEmail } from './setup-email.js';
import type { SetupRecord, SetupTokenStore } from './setup-token.store.js';

/**
 * The first-run wizard, server side (M0-08).
 *
 * Everything here runs before anybody can sign in, which makes two rules
 * absolute. **Nothing is reachable once the install is set up**: step 1 is
 * refused the moment a user row exists, and steps 2 to 4 are refused without
 * the token step 1 issued, which is consumed when the wizard finishes. And
 * **every write is an explicit, audited system path** (AGENTS.md): the
 * transactions name `principal_type = system` with `principal_id =
 * install.setup`, and each step leaves an `install.setup.*` row in the
 * install-scope audit log.
 *
 * The first-run window is the one moment a Helpdock install trusts whoever
 * reaches it, because there is nobody yet to check against — the shape every
 * self-hosted first-run wizard has. It is kept as small as it can be: the
 * per-address limits below, and an install guide that tells operators to finish
 * the wizard before the host is reachable from anywhere else.
 */

/** Recorded in `app.principal_id`, so the audit trail names this path. */
export const SETUP_PRINCIPAL_ID = 'install.setup';

export const SETUP_ADMIN_ACTION = 'install.setup.admin';
export const SETUP_BRAND_ACTION = 'install.setup.brand';
export const SETUP_SMTP_ACTION = 'install.setup.smtp';

/**
 * `HDSW`, and deliberately not the migration lock's `HDMG`. Held for the length
 * of the transaction that creates the admin, so two browsers posting step 1 at
 * the same instant serialise and the second sees the row the first wrote.
 */
const SETUP_LOCK_ID = 0x48445357;

/**
 * Per address, for the wizard as a whole. Generous, because filling in four
 * forms makes a dozen calls and a typo costs another; low enough that the
 * fresh-install window is not somewhere to grind.
 */
export const SETUP_IP_RULE: RateLimitRule = {
  bucket: 'setup-ip',
  limit: 30,
  windowSeconds: 15 * 60,
};

/**
 * Tighter, because this one opens a socket to a host the caller named. It is
 * the only call in the api that does, and ten attempts is more than anybody
 * needs to get a relay's password right.
 */
export const SETUP_SMTP_TEST_IP_RULE: RateLimitRule = {
  bucket: 'setup-smtp-test',
  limit: 10,
  windowSeconds: 15 * 60,
};

/** The `smtp.*` keys the wizard writes. Also what it reports as env-locked. */
const SMTP_KEYS = [
  'smtp.host',
  'smtp.port',
  'smtp.tls',
  'smtp.user',
  'smtp.password',
  'smtp.from',
  'smtp.fromName',
] as const satisfies readonly SettingKey[];

/** What the service needs of an SMTP transport, so a test can hand it one. */
export interface SmtpTester {
  test(message: EmailMessage): Promise<SmtpTestResult>;
  close(): void;
}

export type SmtpTesterFactory = (options: SmtpEmailSenderOptions) => SmtpTester;

export interface SetupServiceOptions {
  readonly db: Db;
  readonly settings: Settings;
  readonly hasher: PasswordHasher;
  readonly sessions: SessionService;
  readonly tokens: SetupTokenStore;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  /** Replaced by the unit suite, which has no relay to talk to. */
  readonly smtp?: SmtpTesterFactory;
}

export interface CreatedBrand {
  readonly response: SetupBrandResponse;
  /**
   * The session the admin is signed in with. It can only be opened here: until
   * the brand exists the account holds no role, and a session with no brand is
   * one no screen can render (`buildSession`).
   */
  readonly issued: IssuedSession | null;
}

export interface SetupCallContext {
  readonly ip: string;
  readonly token: string | undefined;
  readonly userAgent?: string | undefined;
}

export class SetupService {
  readonly #db: Db;
  readonly #settings: Settings;
  readonly #hasher: PasswordHasher;
  readonly #sessions: SessionService;
  readonly #tokens: SetupTokenStore;
  readonly #limiter: RateLimiter;
  readonly #logger: Logger;
  readonly #smtp: SmtpTesterFactory;

  constructor({
    db,
    settings,
    hasher,
    sessions,
    tokens,
    limiter,
    logger,
    smtp = (options) => new SmtpEmailSender(options),
  }: SetupServiceOptions) {
    this.#db = db;
    this.#settings = settings;
    this.#hasher = hasher;
    this.#sessions = sessions;
    this.#tokens = tokens;
    this.#limiter = limiter;
    this.#logger = logger;
    this.#smtp = smtp;
  }

  // ------------------------------------------------------------------
  // Step 1 — the admin account
  // ------------------------------------------------------------------

  async createAdmin(
    input: SetupAdminRequest,
    { ip }: { readonly ip: string },
  ): Promise<SetupAdminResponse> {
    await this.#throttle(SETUP_IP_RULE, ip);
    if ((await readInstallState(this.#db)) !== 'fresh') {
      throw wizardClosed();
    }

    // Outside the transaction: argon2 spends 19 MiB and two passes, and a
    // connection held for that long is a connection nobody else can have.
    const passwordHash = await this.#hasher.hash(input.password);
    const userId = uuidv7();

    await this.#inInstallScope((tx) => this.#insertAdmin(tx, { input, userId, passwordHash }));

    const { token, expiresInSeconds } = await this.#tokens.issue({
      userId,
      email: input.email,
      brandId: null,
    });

    this.#logger.info({ userId }, 'First-run wizard: install admin created');

    return {
      setupToken: token,
      expiresInSeconds,
      admin: { id: userId, name: input.name, email: input.email },
    };
  }

  // ------------------------------------------------------------------
  // Step 2 — the first brand
  // ------------------------------------------------------------------

  async createBrand(input: SetupBrandRequest, call: SetupCallContext): Promise<CreatedBrand> {
    await this.#throttle(SETUP_IP_RULE, call.ip);
    const { token, record } = await this.#requireToken(call.token);

    const brandId = uuidv7();

    try {
      await this.#inInstallScope(
        (tx) => this.#insertBrand(tx, { input, brandId, userId: record.userId }),
        // The role and the domain belong to the new brand, the audit row to the
        // install, so this transaction names both.
        [brandId],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw prefixOrDomainTaken(input);
      }
      throw error;
    }

    await this.#tokens.update(token, { ...record, brandId });

    const issued = await this.#sessions.open({
      userId: record.userId,
      userAgent: call.userAgent,
    });

    return {
      response: {
        brand: {
          id: brandId,
          name: input.name,
          prefix: input.prefix,
          defaultLocale: input.defaultLocale,
          timezone: input.timezone,
        },
        helpcenterDomain: input.helpcenterDomain ?? null,
        departmentCreated: false,
      },
      issued,
    };
  }

  // ------------------------------------------------------------------
  // Step 3 — outgoing email
  // ------------------------------------------------------------------

  async saveSmtp(input: SetupSmtpRequest, call: SetupCallContext): Promise<SetupSmtpResponse> {
    await this.#throttle(SETUP_IP_RULE, call.ip);
    const { record } = await this.#requireToken(call.token);

    const locked = SMTP_KEYS.filter((key) => this.#settings.isLockedByEnv(key));

    if (!input.skip) {
      await this.#write('smtp.host', input.host);
      await this.#write('smtp.port', input.port);
      await this.#write('smtp.tls', input.tls);
      await this.#write('smtp.user', input.user);
      await this.#write('smtp.password', input.password);
      await this.#write('smtp.from', input.fromAddress);
      await this.#write('smtp.fromName', input.fromName);
    }

    await this.#inInstallScope((tx) =>
      tx.insert(auditLog).values({
        brandId: INSTALL_SCOPE_BRAND_ID,
        actorType: 'system',
        actorId: SETUP_PRINCIPAL_ID,
        action: SETUP_SMTP_ACTION,
        targetType: 'setting',
        targetId: 'smtp',
        // Host, port and mode; never the user or the password. An audit row is
        // read by every admin, and one of those is a secret (REQUIREMENTS §5.1).
        meta: {
          userId: record.userId,
          skipped: input.skip,
          lockedByEnvironment: locked,
          ...(input.skip ? {} : { host: input.host, port: input.port, tls: input.tls }),
        },
      }),
    );

    return { configured: !input.skip };
  }

  /**
   * Sends one message with the credentials that are on screen, to the admin's
   * own address. It answers with an outcome rather than throwing, because "the
   * relay refused the password" is a result the form draws inline.
   */
  async testSmtp(input: SmtpCredentials, call: SetupCallContext): Promise<SmtpTestResult> {
    await this.#throttle(SETUP_IP_RULE, call.ip);
    await this.#throttle(SETUP_SMTP_TEST_IP_RULE, call.ip);
    const { record } = await this.#requireToken(call.token);

    const rows = await this.#db
      .select({ name: users.name, email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, record.userId))
      .limit(1);

    const admin = rows[0];
    if (admin === undefined) {
      // The account went away while the wizard was open. Nothing left to do.
      throw wizardClosed();
    }

    const sender = this.#smtp(input);
    try {
      const result = await sender.test(
        renderSmtpTestEmail({
          to: admin.email,
          name: admin.name,
          host: input.host,
          locale: admin.locale,
        }),
      );

      this.#logger.info(
        { host: input.host, port: input.port, tls: input.tls, delivered: result.delivered },
        'First-run wizard: SMTP test attempted',
      );

      return result;
    } finally {
      // One transport per attempt, closed whatever happened, so a wrong host
      // does not leave a socket behind for every retry.
      sender.close();
    }
  }

  // ------------------------------------------------------------------
  // Step 4 — done
  // ------------------------------------------------------------------

  /** Spends the token. Every wizard endpoint answers 409 from here on. */
  async complete(call: SetupCallContext): Promise<SetupCompleteResponse> {
    await this.#throttle(SETUP_IP_RULE, call.ip);

    const record = await this.#tokens.consume(call.token);
    if (record === null) {
      throw wizardClosed();
    }

    this.#logger.info({ userId: record.userId }, 'First-run wizard: finished');

    return { require2fa: await this.#settings.get('auth.require2fa') };
  }

  // ------------------------------------------------------------------
  // The two writers, each the whole of one transaction
  // ------------------------------------------------------------------

  async #insertAdmin(
    tx: DbTransaction,
    {
      input,
      userId,
      passwordHash,
    }: { input: SetupAdminRequest; userId: string; passwordHash: string },
  ): Promise<void> {
    // Two browsers can reach this line at the same instant on a fresh install.
    // The lock serialises them and the re-check below is what the second one
    // loses on, so a race leaves one admin and one 409 rather than two owners.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_ID}::bigint)`);

    const existing = await tx.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      throw wizardClosed();
    }

    await tx.insert(users).values({
      id: userId,
      email: input.email,
      name: input.name,
      passwordHash,
      locale: input.locale,
      status: 'active',
      installAdmin: true,
    });

    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      // The actor is the setup path itself: nobody was authenticated when this
      // ran, and the account it created is the target, not the actor.
      actorType: 'system',
      actorId: SETUP_PRINCIPAL_ID,
      action: SETUP_ADMIN_ACTION,
      targetType: 'user',
      targetId: userId,
      meta: { locale: input.locale },
    });
  }

  async #insertBrand(
    tx: DbTransaction,
    { input, brandId, userId }: { input: SetupBrandRequest; brandId: string; userId: string },
  ): Promise<void> {
    await tx.insert(brands).values({
      id: brandId,
      name: input.name,
      prefix: input.prefix,
      defaultLocale: input.defaultLocale,
      timezone: input.timezone,
    });

    await tx.insert(userBrandRoles).values({ userId, brandId, role: 'admin', departmentIds: null });

    if (input.helpcenterDomain !== undefined) {
      await tx.insert(brandDomains).values({
        brandId,
        domain: input.helpcenterDomain,
        kind: 'helpcenter',
        // Unverified: `verified_at` stays null until M5 sees the TXT record,
        // and Caddy issues no certificate for it before then.
        txtToken: uuidv7(),
      });
    }

    // The brand's default department, "General", belongs here. The
    // `departments` table arrives with M0-06; until it does there is nothing
    // to insert, and `departmentCreated` in the response says so.

    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'system',
      actorId: SETUP_PRINCIPAL_ID,
      action: SETUP_BRAND_ACTION,
      targetType: 'brand',
      targetId: brandId,
      meta: {
        userId,
        prefix: input.prefix,
        helpcenterDomain: input.helpcenterDomain ?? null,
      },
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * A key pinned with `HD_SMTP_…` already wins over the database
   * (ARCHITECTURE §4), so writing one would only store a value nothing reads.
   */
  async #write<TKey extends SettingKey>(key: TKey, value: SettingValue<TKey>): Promise<void> {
    if (this.#settings.isLockedByEnv(key)) {
      return;
    }

    await this.#settings.set(key, value, { updatedBy: SETUP_PRINCIPAL_ID });
  }

  async #requireToken(
    token: string | undefined,
  ): Promise<{ readonly token: string; readonly record: SetupRecord }> {
    const record = await this.#tokens.read(token);
    if (record === null || token === undefined) {
      throw wizardClosed();
    }

    return { token, record };
  }

  async #throttle(rule: RateLimitRule, ip: string): Promise<void> {
    if (!(await this.#limiter.consume(rule, ip))) {
      throw new HttpException(
        'Too many setup attempts from this address; try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * A transaction that may write install-scope rows, and optionally one brand's
   * rows too. It is the widest scope the api opens outside `StaffRepository`,
   * so it stays in this file and every caller audits what it did.
   */
  #inInstallScope<T>(
    run: (tx: DbTransaction) => Promise<T>,
    extraBrandIds: readonly string[] = [],
  ): Promise<T> {
    return withTenant(
      this.#db,
      {
        brandIds: [INSTALL_SCOPE_BRAND_ID, ...extraBrandIds],
        departmentIds: 'all',
        principalType: 'system',
        principalId: SETUP_PRINCIPAL_ID,
      },
      run,
    );
  }
}

/**
 * The one answer every wizard route gives once it is not wanted any more. It is
 * deliberately the same for "this install already has an admin" and "your
 * wizard token is gone": both mean the wizard is closed, and telling them apart
 * would say something about the install to somebody who is not in it.
 */
const wizardClosed = (): ConflictException =>
  new ConflictException('This install has already been set up');

/**
 * A `ZodError` rather than a `ConflictException`, because the client has to
 * tell this apart from "the wizard is closed", which is the api's other 409,
 * and because it *is* a rejected field: the exception filter turns it into a
 * 400 with `fields: [{ path: 'prefix', … }]`, which the step draws under the
 * prefix input (`http/error-response.ts`).
 *
 * Both unique indexes on this transaction are on values the step collected, so
 * either one is reported against the prefix only when the domain was not the
 * cause; naming both would be guessing.
 */
const prefixOrDomainTaken = (input: SetupBrandRequest): ZodError =>
  new ZodError([
    {
      code: 'custom',
      path: [input.helpcenterDomain === undefined ? 'prefix' : 'prefixOrDomain'],
      message: 'is already in use on this install',
      input,
    },
  ]);

/** Postgres's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Whether this failure is the prefix, or the domain, already being taken.
 *
 * The chain is walked because Drizzle wraps a driver error in a
 * `DrizzleQueryError` and puts the original on `cause`; reading `code` off the
 * top would see nothing and turn a rejected field into a 500.
 */
const isUniqueViolation = (error: unknown): boolean => {
  for (let current = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    if ((current as { readonly code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }

  return false;
};
