import type { EmailSender } from '@helpdock/channels';
import type { Keyring, Settings } from '@helpdock/config';
import { decryptSecret, encryptSecret } from '@helpdock/config';
import type { Locale } from '@helpdock/i18n';
import type {
  AuthMethods,
  AuthSessionResponse,
  OauthProvider,
  RecoveryCodes,
  Session,
  TotpEnrolment,
} from '@helpdock/schemas';
import { OAUTH_PROVIDERS as OAUTH_PROVIDER_IDS } from '@helpdock/schemas';
import type { Logger } from '../logging/logger.js';
import { AuthFailure } from './auth-failure.js';
import { renderAuthEmail } from './email-templates.js';
import type { EmailTokenStore } from './email-token.store.js';
import type { ExchangeStore } from './exchange.store.js';
import type { OauthService } from './oauth/oauth.service.js';
import { OauthError } from './oauth/oauth.service.js';
import type { PasswordHasher } from './password.js';
import {
  EMAIL_DISPATCH_RULE,
  type RateLimiter,
  SIGN_IN_EMAIL_RULE,
  SIGN_IN_IP_RULE,
} from './rate-limit.js';
import type { IssuedSession, SessionService } from './session/session.service.js';
import type { Queryable, StaffRepository, StaffUser } from './staff.repository.js';
import type { TotpChallengeStore } from './totp/challenge-store.js';
import { hashRecoveryCodes, newRecoveryCodes, spendRecoveryCode } from './totp/recovery-codes.js';
import { newTotpSecret, totpUri, verifyTotpCode } from './totp/totp.js';
import type { TrustedDeviceStore } from './totp/trusted-device.js';

/**
 * Every way into this install, in one service.
 *
 * Three rules run through all of it:
 *
 * 1. **Nothing confirms who works here.** An unknown address and a wrong
 *    password answer the same code after the same amount of work; a magic link
 *    and a password reset answer `204` whoever asked. The sign-in form is the
 *    one place an anonymous caller can ask a question about a person, and it
 *    has to be a question with only one answer (REQUIREMENTS §5.1).
 * 2. **A credential is spent where it is checked.** Challenges, links and codes
 *    all live in Redis with a TTL and are deleted on use, so nothing succeeds
 *    twice.
 * 3. **The second factor is not optional once it is on.** Every path that
 *    proves a first factor — password, magic link, OAuth — goes through the
 *    same check afterwards.
 */

/** Ten minutes, the same figure DOMAIN-RULES §4.6 gives for a magic link. */
export const PASSWORD_RESET_TTL_MINUTES = 10;

const SECONDS_PER_MINUTE = 60;

export type SignInOutcome =
  | { readonly kind: 'session'; readonly issued: IssuedSession }
  | { readonly kind: 'totp-required'; readonly challengeId: string; readonly email: string }
  | { readonly kind: 'totp-enrolment-required'; readonly challengeId: string };

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly trustedDeviceCookie: string | undefined;
}

export interface AuthServiceOptions {
  readonly staff: StaffRepository;
  readonly sessions: SessionService;
  readonly hasher: PasswordHasher;
  readonly challenges: TotpChallengeStore;
  readonly trustedDevices: TrustedDeviceStore;
  readonly tokens: EmailTokenStore;
  readonly exchanges: ExchangeStore;
  readonly limiter: RateLimiter;
  readonly oauth: OauthService;
  readonly settings: Settings;
  readonly keyring: Keyring;
  readonly email: EmailSender;
  readonly logger: Logger;
  readonly appUrl: string;
}

export class AuthService {
  readonly #parts: AuthServiceOptions;

  constructor(options: AuthServiceOptions) {
    this.#parts = options;
  }

  /** What the sign-in screen may show. Public, and the same answer for everybody. */
  async methods(): Promise<AuthMethods> {
    const oauth: Record<string, boolean> = {};
    for (const provider of OAUTH_PROVIDER_IDS) {
      oauth[provider] = await this.#parts.oauth.isEnabled(provider);
    }

    return {
      password: true,
      // A link nobody can receive is not a way in. Until M2 wires SMTP the
      // development sender writes to the log, which is a real way in for an
      // operator reading it, so the method stays on.
      magicLink: true,
      oauth: oauth as AuthMethods['oauth'],
    };
  }

  // ------------------------------------------------------------------
  // Password
  // ------------------------------------------------------------------

  async signIn(input: SignInInput): Promise<SignInOutcome> {
    await this.#assertSignInAllowed(input.email, input.ip);

    const user = await this.#parts.staff.findByEmail(input.email);

    // The unknown-address branch still runs argon2, against a hash nobody knows
    // the password to, so that "no such user" and "wrong password" cost the
    // same. Without it the form is an address oracle with a stopwatch.
    if (user === undefined || user.passwordHash === null || !this.#isUsable(user)) {
      await this.#parts.hasher.burnVerificationTime(input.password);
      throw new AuthFailure('invalid-credentials');
    }

    const verification = await this.#parts.hasher.verify(user.passwordHash, input.password);
    if (!verification.valid) {
      throw new AuthFailure('invalid-credentials');
    }

    // Only now, with the password proved, is it safe to say the account is
    // locked: saying it earlier would tell a stranger the address exists.
    if (await this.#parts.challenges.isLocked(user.id)) {
      throw new AuthFailure('totp-locked');
    }

    if (verification.needsRehash) {
      // The one moment the plaintext is in hand. A hash made with weaker
      // parameters, or by an older release, is replaced now or never.
      await this.#parts.staff.updatePasswordHash(
        user.id,
        await this.#parts.hasher.hash(input.password),
      );
      this.#parts.logger.info(
        { userId: user.id },
        'Rehashed a password with the current parameters',
      );
    }

    await this.#parts.limiter.reset(SIGN_IN_EMAIL_RULE, input.email);

    return this.#afterFirstFactor(user, {
      userAgent: input.userAgent,
      trustedDeviceCookie: input.trustedDeviceCookie,
    });
  }

  // ------------------------------------------------------------------
  // Second factor
  // ------------------------------------------------------------------

  async verifyTotp({
    challengeId,
    code,
    trustDevice,
    userAgent,
  }: {
    readonly challengeId: string;
    readonly code: string;
    readonly trustDevice: boolean;
    readonly userAgent: string | undefined;
  }): Promise<{ readonly issued: IssuedSession; readonly trustedDeviceCookie: string | null }> {
    const { challenge, user } = await this.#requireChallenge(challengeId, 'second-factor');

    const secret = this.#totpSecretOf(user);
    if (secret === null || !(await verifyTotpCode({ secret, code }))) {
      throw await this.#spendAttempt(challengeId, challenge, 'totp-mismatch');
    }

    await this.#parts.challenges.consume(challengeId);
    const issued = await this.#openSession(user, userAgent);

    return {
      issued,
      trustedDeviceCookie: trustDevice ? await this.#parts.trustedDevices.trust(user.id) : null,
    };
  }

  async useRecoveryCode({
    challengeId,
    code,
    userAgent,
  }: {
    readonly challengeId: string;
    readonly code: string;
    readonly userAgent: string | undefined;
  }): Promise<IssuedSession> {
    const { challenge, user } = await this.#requireChallenge(challengeId, 'second-factor');

    const match = await spendRecoveryCode(code, user.recoveryCodesHashed, this.#parts.hasher);
    if (match === null) {
      throw await this.#spendAttempt(challengeId, challenge, 'recovery-invalid');
    }

    // Spent before the session exists: a crash between the two costs the person
    // one recovery code, which is the right way round.
    await this.#parts.staff.replaceRecoveryCodes(user.id, match.remaining);
    await this.#parts.challenges.consume(challengeId);
    this.#parts.logger.warn(
      { userId: user.id, remaining: match.remaining.length },
      'A recovery code was spent to sign in',
    );

    return this.#openSession(user, userAgent);
  }

  // ------------------------------------------------------------------
  // Enrolment, for the signed-in account itself
  // ------------------------------------------------------------------

  /**
   * Stages a secret and returns what a QR code needs. Nothing is enabled until
   * a live code proves the authenticator actually holds it, so a person cannot
   * lock themselves out by scanning a code that did not save.
   */
  async enrolTotp(userId: string, tx?: Queryable): Promise<TotpEnrolment> {
    const user = await this.#requireUser(userId, tx);
    const secret = newTotpSecret();

    await this.#parts.staff.stageTotpSecret(
      user.id,
      encryptSecret(secret, this.#parts.keyring),
      tx,
    );

    return {
      secret,
      uri: totpUri({ secret, email: user.email, issuer: new URL(this.#parts.appUrl).host }),
    };
  }

  /** Enables the second factor and hands over the recovery codes, once. */
  async confirmTotp(userId: string, code: string, tx?: Queryable): Promise<RecoveryCodes> {
    const user = await this.#requireUser(userId, tx);
    const secret = this.#totpSecretOf(user);

    if (secret === null || !(await verifyTotpCode({ secret, code }))) {
      throw new AuthFailure('totp-mismatch');
    }

    const recoveryCodes = newRecoveryCodes();
    await this.#parts.staff.enableTotp(
      user.id,
      await hashRecoveryCodes(recoveryCodes, this.#parts.hasher),
      tx,
    );
    await this.#parts.challenges.clearLock(user.id);
    this.#parts.logger.info({ userId: user.id }, 'Enabled the second factor for a staff account');

    return { recoveryCodes };
  }

  // ------------------------------------------------------------------
  // Magic link
  // ------------------------------------------------------------------

  /**
   * Always resolves. The caller answers 204 whatever happened here, so the form
   * cannot be used to find out which addresses belong to staff.
   */
  async requestMagicLink({
    email,
    ip,
  }: {
    readonly email: string;
    readonly ip: string;
  }): Promise<void> {
    if (!(await this.#allowEmailDispatch(email, ip))) {
      return;
    }

    const user = await this.#parts.staff.findByEmail(email);
    if (user === undefined || !this.#isUsable(user)) {
      return;
    }

    const minutes = await this.#parts.settings.get('auth.magicLinkTtlMinutes');
    const token = await this.#parts.tokens.issue(
      { purpose: 'magic-link', userId: user.id, email: user.email, issuedAt: Date.now() },
      minutes * SECONDS_PER_MINUTE,
    );

    await this.#send({
      kind: 'magicLink',
      user,
      url: new URL(`/api/auth/magic-link/${token}`, this.#parts.appUrl).toString(),
      ttlMinutes: minutes,
    });
  }

  /** Spends the link. The second factor still applies afterwards. */
  async consumeMagicLink(
    token: string,
    userAgent: string | undefined,
  ): Promise<SignInOutcome | null> {
    const payload = await this.#parts.tokens.consume(token, 'magic-link');
    if (payload === null) {
      return null;
    }

    const user = await this.#parts.staff.findById(payload.userId);
    if (user === undefined || !this.#isUsable(user)) {
      return null;
    }

    return this.#afterFirstFactor(user, { userAgent, trustedDeviceCookie: undefined });
  }

  // ------------------------------------------------------------------
  // Password reset
  // ------------------------------------------------------------------

  async requestPasswordReset({
    email,
    ip,
  }: {
    readonly email: string;
    readonly ip: string;
  }): Promise<void> {
    if (!(await this.#allowEmailDispatch(email, ip))) {
      return;
    }

    const user = await this.#parts.staff.findByEmail(email);
    if (user === undefined || !this.#isUsable(user)) {
      return;
    }

    const token = await this.#parts.tokens.issue(
      { purpose: 'password-reset', userId: user.id, email: user.email, issuedAt: Date.now() },
      PASSWORD_RESET_TTL_MINUTES * SECONDS_PER_MINUTE,
    );

    await this.#send({
      kind: 'passwordReset',
      user,
      url: new URL(
        `/sign-in/reset?token=${encodeURIComponent(token)}`,
        this.#parts.appUrl,
      ).toString(),
      ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
    });
  }

  /**
   * A new password ends every session this account holds, everywhere, and
   * forgets every browser it trusted. Somebody resets a password because they
   * think somebody else has it, and leaving the old sessions alive would make
   * the reset pointless.
   */
  async resetPassword({
    token,
    password,
  }: {
    readonly token: string;
    readonly password: string;
  }): Promise<void> {
    const payload = await this.#parts.tokens.consume(token, 'password-reset');
    if (payload === null) {
      throw new AuthFailure('challenge-expired');
    }

    const user = await this.#parts.staff.findById(payload.userId);
    if (user === undefined || !this.#isUsable(user)) {
      throw new AuthFailure('challenge-expired');
    }

    await this.#parts.staff.updatePasswordHash(user.id, await this.#parts.hasher.hash(password));
    await this.#parts.staff.markActive(user.id);
    await this.#parts.trustedDevices.revokeAll(user.id);
    await this.#parts.sessions.revokeEverything(user.id, 'password-reset');

    this.#parts.logger.info({ userId: user.id }, 'Password reset; every session was revoked');
  }

  // ------------------------------------------------------------------
  // OAuth
  // ------------------------------------------------------------------

  async startOauth(provider: OauthProvider): Promise<string> {
    try {
      return await this.#parts.oauth.start(provider);
    } catch (error) {
      this.#parts.logger.warn({ err: error, provider }, 'Could not start an OAuth flow');
      throw new AuthFailure('unavailable');
    }
  }

  /**
   * Matches on a verified address and nothing else. No account is created:
   * owning a Google address is not a reason to be staff here.
   */
  async completeOauth({
    provider,
    code,
    state,
    userAgent,
  }: {
    readonly provider: OauthProvider;
    readonly code: string;
    readonly state: string;
    readonly userAgent: string | undefined;
  }): Promise<SignInOutcome> {
    let identity: Awaited<ReturnType<OauthService['complete']>>;
    try {
      identity = await this.#parts.oauth.complete({ provider, code, state });
    } catch (error) {
      this.#parts.logger.warn({ err: error, provider }, 'An OAuth callback could not be completed');
      throw new AuthFailure(error instanceof OauthError ? 'no-account' : 'unavailable');
    }

    const user = await this.#parts.staff.findByEmail(identity.email);
    if (user === undefined || !this.#isUsable(user)) {
      throw new AuthFailure('no-account');
    }

    return this.#afterFirstFactor(user, { userAgent, trustedDeviceCookie: undefined });
  }

  // ------------------------------------------------------------------
  // The redirect hand-off
  // ------------------------------------------------------------------

  /** Stores the one-time code a redirect carries instead of an access token. */
  async issueExchangeCode(issued: IssuedSession): Promise<string> {
    return this.#parts.exchanges.issue({
      userId: issued.session.user.id,
      familyId: issued.refreshCookieValue.fam,
    });
  }

  async exchange(code: string): Promise<AuthSessionResponse> {
    const record = await this.#parts.exchanges.consume(code);
    if (record === null) {
      throw new AuthFailure('challenge-expired');
    }

    const resumed = await this.#parts.sessions.resume(record);
    if (resumed === null) {
      throw new AuthFailure('challenge-expired');
    }

    return resumed;
  }

  // ------------------------------------------------------------------
  // The session itself
  // ------------------------------------------------------------------

  async me(userId: string, tx?: Queryable): Promise<Session | null> {
    return this.#parts.sessions.describe(userId, tx);
  }

  /**
   * Every family and every trusted browser. Leaving the trusted-device cookies
   * alive would mean a browser somebody else has still skips the second factor,
   * which is the one thing "log out everywhere" is asked for.
   */
  async signOutEverywhere(userId: string): Promise<void> {
    await this.#parts.trustedDevices.revokeAll(userId);
    const revoked = await this.#parts.sessions.revokeEverything(userId, 'sign-out-everywhere');

    this.#parts.logger.info({ userId, revoked }, 'Signed a staff account out everywhere');
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * What happens once a first factor is proved, whichever one it was: a trusted
   * browser goes straight in, an account with an authenticator is challenged,
   * and an install that requires 2FA sends an account without one to enrolment.
   */
  async #afterFirstFactor(
    user: StaffUser,
    {
      userAgent,
      trustedDeviceCookie,
    }: { readonly userAgent: string | undefined; readonly trustedDeviceCookie: string | undefined },
  ): Promise<SignInOutcome> {
    if (user.totpEnabled) {
      if (await this.#parts.trustedDevices.isTrusted(user.id, trustedDeviceCookie)) {
        return { kind: 'session', issued: await this.#openSession(user, userAgent) };
      }

      return {
        kind: 'totp-required',
        challengeId: await this.#parts.challenges.create({
          userId: user.id,
          kind: 'second-factor',
        }),
        email: user.email,
      };
    }

    if (await this.#parts.settings.get('auth.require2fa')) {
      return {
        kind: 'totp-enrolment-required',
        challengeId: await this.#parts.challenges.create({ userId: user.id, kind: 'enrolment' }),
      };
    }

    return { kind: 'session', issued: await this.#openSession(user, userAgent) };
  }

  async #openSession(user: StaffUser, userAgent: string | undefined): Promise<IssuedSession> {
    // An invited account becomes active the first time it proves an identity
    // (DOMAIN-RULES §12).
    if (user.status === 'invited') {
      await this.#parts.staff.markActive(user.id);
    }

    const issued = await this.#parts.sessions.open({ userId: user.id, userAgent });
    if (issued === null) {
      // Nothing to sign in to: this account holds no role in any brand.
      throw new AuthFailure('no-account');
    }

    return issued;
  }

  async #assertSignInAllowed(email: string, ip: string): Promise<void> {
    const withinIpBudget = await this.#parts.limiter.consume(SIGN_IN_IP_RULE, ip);
    const withinEmailBudget = await this.#parts.limiter.consume(SIGN_IN_EMAIL_RULE, email);

    // Both are consumed before either is judged, so which limit was hit cannot
    // be read off the response, and neither can the existence of the address.
    if (!withinIpBudget || !withinEmailBudget) {
      this.#parts.logger.warn({ ip }, 'A sign-in attempt was refused by the rate limit');
      throw new AuthFailure('unavailable');
    }
  }

  async #allowEmailDispatch(email: string, ip: string): Promise<boolean> {
    const withinEmailBudget = await this.#parts.limiter.consume(EMAIL_DISPATCH_RULE, email);
    const withinIpBudget = await this.#parts.limiter.consume(SIGN_IN_IP_RULE, ip);

    return withinEmailBudget && withinIpBudget;
  }

  async #requireChallenge(
    challengeId: string,
    kind: 'second-factor' | 'enrolment',
  ): Promise<{ challenge: Awaited<ReturnType<TotpChallengeStore['read']>>; user: StaffUser }> {
    const found = await this.#parts.challenges.read(challengeId);
    if (found.status === 'locked') {
      throw new AuthFailure('totp-locked');
    }
    if (found.status !== 'ok' || found.challenge.kind !== kind) {
      throw new AuthFailure('challenge-expired');
    }

    const user = await this.#parts.staff.findById(found.challenge.userId);
    if (user === undefined || !this.#isUsable(user)) {
      throw new AuthFailure('challenge-expired');
    }

    return { challenge: found, user };
  }

  /**
   * A wrong value costs one attempt whichever form it was typed into, so a lock
   * cannot be dodged by switching to the recovery code field.
   */
  async #spendAttempt(
    challengeId: string,
    found: Awaited<ReturnType<TotpChallengeStore['read']>>,
    code: 'totp-mismatch' | 'recovery-invalid',
  ): Promise<AuthFailure> {
    /* c8 ignore next 3 -- `#requireChallenge` only ever hands over an `ok`. */
    if (found.status !== 'ok') {
      return new AuthFailure('challenge-expired');
    }

    const outcome = await this.#parts.challenges.spendAttempt(challengeId, found.challenge);
    if (outcome.status === 'locked') {
      this.#parts.logger.warn(
        { userId: found.challenge.userId },
        'A second-factor challenge used its last attempt; the account is locked for 15 minutes',
      );
      return new AuthFailure('totp-locked');
    }

    return new AuthFailure(code, { attemptsLeft: outcome.attemptsLeft });
  }

  async #requireUser(userId: string, tx?: Queryable): Promise<StaffUser> {
    const user = await this.#parts.staff.findById(userId, tx);
    if (user === undefined || !this.#isUsable(user)) {
      throw new AuthFailure('no-account');
    }

    return user;
  }

  #totpSecretOf(user: StaffUser): string | null {
    if (user.totpSecretEncrypted === null) {
      return null;
    }

    try {
      return decryptSecret(user.totpSecretEncrypted, this.#parts.keyring);
    } catch (error) {
      // A secret that cannot be decrypted means the master key changed without
      // the rotation procedure. It is an operator problem, not a sign-in
      // problem, and it must be visible in the log rather than as "wrong code".
      this.#parts.logger.error(
        { err: error, userId: user.id },
        'Could not decrypt a stored TOTP secret; check APP_MASTER_KEY and DOMAIN-RULES §10',
      );
      return null;
    }
  }

  /** Deactivated accounts cannot sign in by any route (DOMAIN-RULES §12). */
  #isUsable(user: StaffUser): boolean {
    return user.status !== 'deactivated' && user.deactivatedAt === null;
  }

  async #send({
    kind,
    user,
    url,
    ttlMinutes,
  }: {
    readonly kind: 'magicLink' | 'passwordReset';
    readonly user: StaffUser;
    readonly url: string;
    readonly ttlMinutes: number;
  }): Promise<void> {
    await this.#parts.email.send(
      renderAuthEmail({
        kind,
        to: user.email,
        name: user.name,
        url,
        locale: user.locale as Locale,
        ttlMinutes,
      }),
    );
  }
}
