import { timingSafeEqual } from 'node:crypto';
import type { Keyring, Settings } from '@helpdock/config';
import { decryptSecret, encryptSecret } from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import type {
  AuthenticationResponse,
  AuthMethods,
  AuthSessionResponse,
  EmailTokenPayload,
  MagicLinkPreview,
  OauthIdentityList,
  OauthProvider,
  OauthStepUpRequest,
  PasskeyRegistrationOptions,
  PasskeyStepUpOptions,
  RecoveryCodes,
  RegistrationResponse,
  SecondFactorOptions,
  Session,
  TotpEnrolment,
  TotpRotationProof,
  TotpRotationStart,
} from '@helpdock/schemas';
import {
  isLastSignInMethod,
  MAX_PASSKEYS_PER_ACCOUNT,
  MICROSOFT_CONSUMERS_TENANT_ID,
  OAUTH_PROVIDERS as OAUTH_PROVIDER_IDS,
} from '@helpdock/schemas';
import { runAfterCommit } from '../context/after-commit.js';
import { currentRequestContext } from '../context/request-context.js';
import type { Logger } from '../logging/logger.js';
import { systemSenderConfigured } from '../notifications/install-channels.js';
import type { SsoIdentityService } from '../sso/identity.service.js';
import { type SsoAssertion, ssoAssertionSchema } from '../sso/oidc-contracts.js';
import type { SsoSignInPolicy } from '../sso/sign-in-policy.js';
import type { AuthAuditAction, AuthAuditTrail, SignInMethod } from './auth-audit.js';
import type { AuthEmailRequest, AuthMail } from './auth-email.js';
import { AuthFailure } from './auth-failure.js';
import { assertNotBreached } from './breached/breached-passwords.js';
import { describeClient } from './client-description.js';
import type { EmailTokenStore } from './email-token.store.js';
import type { ExchangeStore } from './exchange.store.js';
import type { OauthIdentity, OauthInviteState, OauthService } from './oauth/oauth.service.js';
import { OauthError } from './oauth/oauth.service.js';
import type { OauthIdentityRepository, OauthLinkedVia } from './oauth/oauth-identity.repository.js';
import { decideOauthSignIn, googleDomainAllowed } from './oauth/oauth-linking.js';
import type { PasskeyRepository } from './passkeys/passkey.repository.js';
import { toAuthenticationJson, toRegistrationJson, toStored } from './passkeys/webauthn-json.js';
import type { PasswordHasher } from './password.js';
import {
  EMAIL_DISPATCH_IP_RULE,
  EMAIL_DISPATCH_RULE,
  MAGIC_LINK_LOOKUP_RULE,
  PASSKEY_CEREMONY_OPTIONS_RULE,
  PASSKEY_SIGN_IN_OPTIONS_RULE,
  type RateLimiter,
  type SignInAttempt,
  STEP_UP_RULE,
} from './rate-limit.js';
import type { SecurityChange } from './security-notice-email.js';
import type { IssuedSession, SessionService } from './session/session.service.js';
import type { Queryable, StaffRepository, StaffUser } from './staff.repository.js';
import type { TotpChallengeStore } from './totp/challenge-store.js';
import { hashRecoveryCodes, newRecoveryCodes, spendRecoveryCode } from './totp/recovery-codes.js';
import { replacedSecretDigest, type TotpRotationStore } from './totp/rotation-store.js';
import { matchTotpStep, newTotpSecret, totpUri } from './totp/totp.js';
import type { TrustedDeviceStore } from './totp/trusted-device.js';
import type { TotpStepStore } from './totp/used-steps.js';
import type { AssertionCheck, WebAuthnService } from './webauthn/webauthn.service.js';

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
 *    same check afterwards. For an Admin or an install admin it is not
 *    optional at all (ASVS 4.3.1).
 *
 * Every decision is also written to the auth audit trail (`auth-audit.ts`),
 * and every change to a credential sends the account holder a `securityChange`
 * email (ASVS 2.2.3), so a change they did not make is one they hear about.
 */

/** Ten minutes, the same figure DOMAIN-RULES §4.6 gives for a magic link. */
export const PASSWORD_RESET_TTL_MINUTES = 10;

const SECONDS_PER_MINUTE = 60;

/**
 * The admin screen a sign-in link opens. The token rides in the fragment, which
 * a browser never sends to a server, so it reaches neither a request log nor a
 * `Referer` header; the screen posts it back only when the person clicks
 * (M9-01 F6).
 */
export const magicLinkScreenUrl = (appUrl: string, token: string): string => {
  const url = new URL('/sign-in/magic', appUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
};

/** What a code typed into a form turned out to be. */
type CodeCheck = 'accepted' | 'mismatch' | 'replayed';

export type SignInOutcome =
  | { readonly kind: 'session'; readonly issued: IssuedSession }
  | {
      readonly kind: 'totp-required';
      readonly challengeId: string;
      readonly email: string;
      readonly factors: SecondFactorOptions;
    }
  | { readonly kind: 'second-factor-enrolment-required'; readonly challengeId: string };

/**
 * An OAuth callback ends a sign-in, connects a provider to the account that
 * started it, or accepts an invitation, which it may refuse because the
 * provider account is not the invited address's.
 */
export type OauthCallbackOutcome =
  | SignInOutcome
  | { readonly kind: 'connected' }
  | { readonly kind: 'invite-mismatch'; readonly account: string };

/** What the staff module needs to accept an invitation once the provider has answered. */
export interface OauthInviteAcceptance {
  readonly invite: OauthInviteState;
  readonly identity: OauthIdentity;
  readonly userAgent: string | undefined;
}

/**
 * Accepting an invitation is the staff module's, and that module depends on
 * this service, so it hands itself over through {@link AuthService.acceptInvitesWith}
 * instead of being injected here.
 */
export interface OauthInviteAcceptor {
  acceptWithProvider(acceptance: OauthInviteAcceptance): Promise<OauthCallbackOutcome>;
}

/** How a provider is named in a security notice: a product name, the same in every language. */
const PROVIDER_NAMES: Readonly<Record<OauthProvider, string>> = {
  google: 'Google',
  microsoft: 'Microsoft',
  github: 'GitHub',
};

/** What one invite message needs beyond the catalogs (M0-06). */
export interface InviteEmailInput {
  /** The invited account. Its address and language are read when the email is sent. */
  readonly userId: string;
  readonly url: string;
  readonly expiresInDays: number;
  readonly inviterName: string;
  readonly brandName: string;
  /** Already translated into the recipient's language by the caller. */
  readonly roleName: string;
}

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly trustedDeviceCookie: string | undefined;
}

export interface AuthServiceOptions {
  readonly sso: SsoIdentityService;
  readonly ssoPolicy: SsoSignInPolicy;
  readonly staff: StaffRepository;
  readonly sessions: SessionService;
  readonly hasher: PasswordHasher;
  readonly challenges: TotpChallengeStore;
  /** The last authenticator step each account used, so no code is accepted twice. */
  readonly steps: TotpStepStore;
  /** The secret staged to replace an enabled authenticator, until a code from the new app confirms it (#373). */
  readonly rotations: TotpRotationStore;
  readonly trustedDevices: TrustedDeviceStore;
  readonly tokens: EmailTokenStore;
  readonly exchanges: ExchangeStore;
  readonly limiter: RateLimiter;
  readonly oauth: OauthService;
  /** Which provider account is bound to which staff account (1.0.1). */
  readonly oauthIdentities: OauthIdentityRepository;
  /** Passkeys (M18-01): the relying party, its pin and the ceremonies. */
  readonly webauthn: WebAuthnService;
  /**
   * The passkeys an account holds: the count a password-reset notice names
   * (M18-02), and a second factor's credentials and their counters (M18-03).
   */
  readonly passkeys: Pick<
    PasskeyRepository,
    | 'add'
    | 'byCredentialId'
    | 'count'
    | 'lockAccount'
    | 'markUsed'
    | 'ofUser'
    | 'transaction'
    | 'userHandle'
  >;
  readonly settings: Settings;
  readonly keyring: Keyring;
  /** Queues auth email through the outbox; the worker sends it (`auth-email.job.ts`). */
  readonly mail: AuthMail;
  readonly audit: AuthAuditTrail;
  readonly logger: Logger;
  readonly appUrl: string;
}

export class AuthService {
  readonly #parts: AuthServiceOptions;
  #inviteAcceptor: OauthInviteAcceptor | undefined;

  constructor(options: AuthServiceOptions) {
    this.#parts = options;
  }

  /** What the sign-in screen may show. Public, and the same answer for everybody. */
  async methods(): Promise<AuthMethods> {
    const enforced = await this.#parts.ssoPolicy.enforced();
    const oauth: Record<string, boolean> = {};
    for (const provider of OAUTH_PROVIDER_IDS) {
      oauth[provider] = !enforced && (await this.#parts.oauth.isEnabled(provider));
    }
    const passkeys = (await this.#parts.webauthn.status()).state;

    return {
      sso: await this.#parts.ssoPolicy.connections(),
      ssoEnforced: enforced,
      password: true,
      // The button is drawn whatever the install's sender is: methods() is read
      // by every visitor, and this is the one place the install's
      // configuration is not advertised. When there is no sender the request
      // itself answers `email-unavailable` (#369), which is the honest answer
      // and the same one for every address.
      magicLink: !enforced,
      oauth: oauth as AuthMethods['oauth'],
      // Passwordless passkey sign-in is a local method, refused under
      // enforcement like the others (ADR 0050).
      passkey: !enforced && passkeys === 'available',
      passkeysPaused: !enforced && passkeys === 'paused',
    };
  }

  // ------------------------------------------------------------------
  // Password
  // ------------------------------------------------------------------

  async signIn(input: SignInInput): Promise<SignInOutcome> {
    const attempt = await this.#assertSignInAllowed(input.email, input.ip);

    await this.#parts.ssoPolicy.assertLocal(input.email, 'password');
    const user = await this.#parts.staff.findByEmail(input.email);

    // The unknown-address branch still runs argon2, against a hash nobody knows
    // the password to, so that "no such user" and "wrong password" cost the
    // same. Without it the form is an address oracle with a stopwatch.
    if (user === undefined || user.passwordHash === null || !this.#isUsable(user)) {
      await this.#parts.hasher.burnVerificationTime(input.password);
      await this.#audit('auth.sign_in.failed', user?.id ?? null, 'system', {
        method: 'password',
        reason: user === undefined ? 'unknown-account' : 'unusable-account',
      });
      throw new AuthFailure('invalid-credentials');
    }

    const verification = await this.#parts.hasher.verify(user.passwordHash, input.password);
    if (!verification.valid) {
      await this.#audit('auth.sign_in.failed', user.id, 'system', {
        method: 'password',
        reason: 'wrong-password',
      });
      throw new AuthFailure('invalid-credentials');
    }

    // Only now, with the password proved, is it safe to say the account is
    // locked: saying it earlier would tell a stranger the address exists.
    if (await this.#parts.challenges.isLocked(user.id)) {
      await this.#audit('auth.sign_in.failed', user.id, 'system', {
        method: 'password',
        reason: 'locked',
      });
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

    const outcome = await this.#afterFirstFactor(user, {
      method: 'password',
      userAgent: input.userAgent,
      trustedDeviceCookie: input.trustedDeviceCookie,
    });
    if (outcome.kind === 'session') {
      await this.#parts.limiter.signInSucceeded(attempt);
    } else {
      await this.#parts.limiter.refundSignIn(attempt);
    }
    return outcome;
  }

  // ------------------------------------------------------------------
  // Second factor
  // ------------------------------------------------------------------

  async verifyTotp({
    challengeId,
    ip,
    code,
    trustDevice,
    userAgent,
  }: {
    readonly challengeId: string;
    readonly ip: string;
    readonly code: string;
    readonly trustDevice: boolean;
    readonly userAgent: string | undefined;
  }): Promise<{ readonly issued: IssuedSession; readonly trustedDeviceCookie: string | null }> {
    const { challenge, user, attempt } = await this.#signInChallenge(
      challengeId,
      'second-factor',
      ip,
    );

    const reserved = await this.#reserveAttempt(challengeId, challenge);
    if ((await this.#checkCode(user, code, 'sign-in')) !== 'accepted') {
      throw await this.#failAttempt(challengeId, challenge, reserved, 'totp-mismatch');
    }

    await this.#consumeChallenge(challengeId, user.id);
    const issued = await this.#openSession(user, userAgent, {
      method: firstFactorOf(challenge),
      secondFactor: 'totp',
    });
    await this.#parts.limiter.signInSucceeded(attempt);
    await this.#parts.challenges.clearFailures(user.id);

    return {
      issued,
      trustedDeviceCookie: trustDevice ? await this.#parts.trustedDevices.trust(user.id) : null,
    };
  }

  async useRecoveryCode({
    challengeId,
    ip,
    code,
    userAgent,
  }: {
    readonly challengeId: string;
    readonly ip: string;
    readonly code: string;
    readonly userAgent: string | undefined;
  }): Promise<IssuedSession> {
    const { challenge, user, attempt } = await this.#signInChallenge(
      challengeId,
      'second-factor',
      ip,
    );

    await this.#parts.ssoPolicy.assertAllowed(firstFactorOf(challenge), 'recovery-code');
    const reserved = await this.#reserveAttempt(challengeId, challenge);
    const match = await spendRecoveryCode(code, user.recoveryCodesHashed, this.#parts.hasher);
    if (match === null) {
      await this.#audit('auth.second_factor.failed', user.id, 'system', {
        factor: 'recovery-code',
      });
      throw await this.#failAttempt(challengeId, challenge, reserved, 'recovery-invalid');
    }

    // The challenge goes first, atomically: if a lock landed while the slow
    // hash was running, no code is spent and no session opens. Then the code is
    // spent before the session exists: a crash between the two costs the person
    // one recovery code, which is the right way round.
    await this.#consumeChallenge(challengeId, user.id);
    await this.#parts.staff.replaceRecoveryCodes(user.id, match.remaining);
    this.#parts.logger.warn(
      { userId: user.id, remaining: match.remaining.length },
      'A recovery code was spent to sign in',
    );
    await this.#audit('auth.recovery_code.used', user.id, 'staff', {
      remaining: match.remaining.length,
    });

    const issued = await this.#openSession(user, userAgent, {
      method: firstFactorOf(challenge),
      secondFactor: 'recovery-code',
    });
    await this.#parts.limiter.signInSucceeded(attempt);
    await this.#parts.challenges.clearFailures(user.id);
    return issued;
  }

  /**
   * Options for answering a second-factor challenge with one of the account's
   * passkeys (M18-03). The challenge id is the credential, as it is for
   * `/totp`. Only now, with the first factor proved, are the account's
   * credentials named in `allowCredentials`; minting options evaluates no
   * guess, so it spends no attempt and gives its IP slot back.
   */
  async passkeySecondFactorOptions({
    challengeId,
    ip,
  }: {
    readonly challengeId: string;
    readonly ip: string;
  }): Promise<PasskeyStepUpOptions> {
    const { challenge, user, attempt } = await this.#signInChallenge(
      challengeId,
      'second-factor',
      ip,
    );
    await this.#assertPasskeyAllowed(challenge);
    await this.#spendCeremonyOptions(user.id);

    const held = await this.#parts.passkeys.ofUser(user.id);
    if (held.length === 0) {
      throw new AuthFailure('invalid-credentials');
    }
    const { ceremonyId, options } = await this.#parts.webauthn.authenticationOptions({
      purpose: await this.#secondFactorPurpose(challenge),
      binding: { userId: user.id, familyId: challengeId },
      allow: held,
    });
    await this.#parts.limiter.refundSignInIp(attempt);

    return { ceremonyId, options: { ...options } };
  }

  /**
   * A passkey as the second factor. It follows the code path to the letter: an
   * attempt is reserved on the challenge and on the account's own counter
   * before the assertion is looked at, so a passkey, a code and a recovery code
   * share one budget and one lock, and the challenge is spent atomically only
   * once the assertion verified. The ceremony is spent when it is checked, so
   * a replayed assertion is a refusal that costs an attempt.
   */
  async verifyPasskeySecondFactor({
    challengeId,
    ip,
    ceremonyId,
    response,
    trustDevice,
    userAgent,
  }: {
    readonly challengeId: string;
    readonly ip: string;
    readonly ceremonyId: string;
    readonly response: AuthenticationResponse;
    readonly trustDevice: boolean;
    readonly userAgent: string | undefined;
  }): Promise<{ readonly issued: IssuedSession; readonly trustedDeviceCookie: string | null }> {
    const { challenge, user, attempt } = await this.#signInChallenge(
      challengeId,
      'second-factor',
      ip,
    );

    await this.#assertPasskeyAllowed(challenge);
    const reserved = await this.#reserveAttempt(challengeId, challenge);

    const check = await this.#checkAssertion(
      user,
      await this.#secondFactorPurpose(challenge),
      ceremonyId,
      challengeId,
      response,
    );
    if (!check.ok) {
      throw await this.#failAttempt(challengeId, challenge, reserved, 'passkey-invalid');
    }

    await this.#consumeChallenge(challengeId, user.id);
    await this.#parts.passkeys.markUsed(
      check.credential.credentialId,
      check.newSignCount,
      check.backedUp,
    );
    const issued = await this.#openSession(user, userAgent, {
      method: firstFactorOf(challenge),
      secondFactor: 'passkey',
    });
    await this.#parts.limiter.signInSucceeded(attempt);
    await this.#parts.challenges.clearFailures(user.id);

    return {
      issued,
      trustedDeviceCookie: trustDevice ? await this.#parts.trustedDevices.trust(user.id) : null,
    };
  }

  // ------------------------------------------------------------------
  // Passwordless passkey sign-in (M18-04)
  // ------------------------------------------------------------------

  /**
   * Options for signing in with a discoverable passkey. They are the same for
   * every caller and name nobody (no `allowCredentials`), so they reveal
   * nothing about any account. Minting them evaluates no guess, so the slot
   * they take from the shared sign-in budget is given back; a second, looser
   * per-IP bucket stops a caller filling Redis with ceremonies.
   */
  async passkeySignInOptions({ ip }: { readonly ip: string }): Promise<PasskeyStepUpOptions> {
    await this.#assertPasskeySignInAllowed();
    if (!(await this.#parts.limiter.consume(PASSKEY_SIGN_IN_OPTIONS_RULE, ip))) {
      throw new AuthFailure('rate-limited');
    }
    const attempt = await this.#assertSignInAllowed(undefined, ip);
    try {
      const { ceremonyId, options } = await this.#parts.webauthn.authenticationOptions({
        purpose: 'passwordless',
      });
      return { ceremonyId, options: { ...options } };
    } finally {
      // Minting evaluates no guess, so the slot goes back whether or not it worked
      // (`passkeys-unavailable` and `passkeys-rp-changed` are thrown from there).
      await this.#parts.limiter.refundSignInIp(attempt);
    }
  }

  /**
   * Signs in with a passkey alone: possession plus the PIN or biometric the
   * authenticator checked (user verification is required), which is why no
   * second factor follows. Every refusal that could say something about who
   * holds an account (an unknown credential, a bad signature, a regressed
   * counter, a deactivated person, an account with no brand, a spent
   * ceremony) answers `invalid-credentials`, and the reason goes to the audit
   * trail only. The slot taken from the sign-in budget is kept on every
   * failure, so guesses draw on the same per-IP budget as passwords.
   *
   * It neither reads nor clears the second-factor lock and failure counter
   * (`totp-locked`): those bound guesses at a six-digit code, and an assertion
   * with user verification is not a guess. A person whose code is locked can
   * still sign in with their passkey, and doing so leaves the counter as it was.
   */
  async verifyPasskeySignIn({
    ip,
    ceremonyId,
    response,
    userAgent,
  }: {
    readonly ip: string;
    readonly ceremonyId: string;
    readonly response: AuthenticationResponse;
    readonly userAgent: string | undefined;
  }): Promise<IssuedSession> {
    await this.#assertPasskeySignInAllowed();
    const attempt = await this.#assertSignInAllowed(undefined, ip);

    const refuse = async (
      userId: string | null,
      reason: string,
      credential?: string,
    ): Promise<never> => {
      await this.#audit('auth.sign_in.failed', userId, 'system', {
        method: 'passkey',
        reason,
      });
      if (reason === 'counter-regressed') {
        await this.#audit('auth.passkey.counter_regressed', userId, 'system', {
          passkey: credential,
        });
      }
      throw new AuthFailure('invalid-credentials');
    };

    let presented: string | undefined;
    let check:
      | AssertionCheck
      | { readonly ok: false; readonly reason: string; readonly userId: string | null };
    try {
      check = await this.#parts.webauthn.verifyAuthentication({
        purpose: 'passwordless',
        ceremonyId,
        response: toAuthenticationJson(response),
        findCredential: async (credentialId) => {
          const row = await this.#parts.passkeys.byCredentialId(credentialId);
          presented = row?.id;
          return row === undefined ? undefined : toStored(row);
        },
      });
    } catch (error) {
      if (!(error instanceof AuthFailure) || error.auth.code !== 'challenge-expired') throw error;
      check = { ok: false, reason: 'ceremony-gone', userId: null };
    }
    if (!check.ok) return refuse(check.userId, check.reason, presented);

    const user = await this.#parts.staff.findById(check.credential.userId);
    if (user === undefined || !this.#isUsable(user)) {
      return refuse(check.credential.userId, 'unusable-account');
    }
    // Defence beyond the library: the flag is required there, and checked here
    // because this one decides that no second factor follows.
    if (!check.userVerified) return refuse(user.id, 'user-verification-missing');
    if (!(await this.#handleMatches(user.id, response.response.userHandle))) {
      return refuse(user.id, 'user-handle-mismatch');
    }

    let issued: IssuedSession;
    try {
      issued = await this.#openSession(user, userAgent, {
        method: 'passkey',
        secondFactor: 'passkey-uv',
      });
    } catch (error) {
      // An account with no role in any brand answers like an unknown
      // credential; the session service has audited the reason.
      if (error instanceof AuthFailure && error.auth.code === 'no-account') {
        throw new AuthFailure('invalid-credentials');
      }
      throw error;
    }
    await this.#parts.passkeys.markUsed(
      check.credential.credentialId,
      check.newSignCount,
      check.backedUp,
    );
    await this.#parts.limiter.signInSucceeded(attempt);
    return issued;
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
    return this.#stageSecret(await this.#requireUser(userId, tx), 'totp-already-enabled', tx);
  }

  /** Enables the second factor and hands over the recovery codes, once. */
  async confirmTotp(userId: string, code: string, tx?: DbTransaction): Promise<RecoveryCodes> {
    // The lock passkey add and remove take: whether this is the account's first
    // second factor must not change while the codes are decided.
    if (tx !== undefined) await this.#parts.passkeys.lockAccount(userId, tx);
    const user = await this.#requireUser(userId, tx);

    if ((await this.#checkCode(user, code, 'enrolment')) !== 'accepted') {
      throw new AuthFailure('totp-mismatch');
    }

    return this.#enableSecondFactor(user, tx);
  }

  // ------------------------------------------------------------------
  // Enrolment before a session: an account that must have a second factor
  // ------------------------------------------------------------------

  /**
   * The first half of enrolment for an account that was handed a
   * `second-factor-enrolment-required` challenge instead of a session. The challenge
   * proves the first factor, as the session does for {@link enrolTotp}; it is
   * not spent here, because the code has yet to be typed.
   */
  async startEnrolment(challengeId: string): Promise<TotpEnrolment> {
    const { user } = await this.#requireChallenge(challengeId, 'enrolment');
    // A challenge stands in for a session only while the account has no second
    // factor. One handed out earlier must not stage over a factor set since.
    if (await this.hasSecondFactor(user)) throw new AuthFailure('challenge-expired');

    return this.#stageSecret(user, 'challenge-expired');
  }

  /**
   * The second half: a live code turns the factor on, the challenge is spent,
   * and the session it stood in for is opened. A wrong code costs an attempt,
   * as it does at sign-in, because this is a sign-in.
   */
  async completeEnrolment({
    challengeId,
    ip,
    code,
    userAgent,
  }: {
    readonly challengeId: string;
    readonly ip: string;
    readonly code: string;
    readonly userAgent: string | undefined;
  }): Promise<{ readonly recoveryCodes: string[]; readonly issued: IssuedSession }> {
    const { challenge, user, attempt } = await this.#signInChallenge(challengeId, 'enrolment', ip);

    const reserved = await this.#reserveAttempt(challengeId, challenge);
    if ((await this.#checkCode(user, code, 'enrolment')) !== 'accepted') {
      throw await this.#failAttempt(challengeId, challenge, reserved, 'totp-mismatch');
    }

    await this.#consumeChallenge(challengeId, user.id);
    const { recoveryCodes } = await this.#parts.passkeys.transaction(async (tx) => {
      // The lock passkey add and remove take, with the check under it: a
      // challenge handed out before the account set a factor of its own must
      // not turn that factor off or add a second one beside it.
      await this.#parts.passkeys.lockAccount(user.id, tx);
      const current = await this.#parts.staff.findById(user.id, tx);
      if (
        current === undefined ||
        !this.#isUsable(current) ||
        (await this.hasSecondFactor(current, tx))
      ) {
        throw new AuthFailure('challenge-expired');
      }
      return this.#enableSecondFactor(current, tx, { notify: false });
    });
    await this.#notifySecurityChange(user.id, 'twoFactorEnabled');
    const issued = await this.#openSession(user, userAgent, {
      method: firstFactorOf(challenge),
      secondFactor: 'totp',
    });
    await this.#parts.limiter.signInSucceeded(attempt);
    await this.#parts.challenges.clearFailures(user.id);

    return { recoveryCodes, issued };
  }

  /**
   * The browser's creation options for a passkey, for an account that holds an
   * enrolment challenge instead of a session (M18-03). The challenge proves the
   * first factor and is not spent here: the authenticator has yet to answer.
   */
  async startPasskeyEnrolment(challengeId: string): Promise<PasskeyRegistrationOptions> {
    const { challenge, user } = await this.#requireChallenge(challengeId, 'enrolment');
    await this.#assertPasskeyAllowed(challenge);
    await this.#spendCeremonyOptions(user.id);

    const existing = await this.#parts.passkeys.ofUser(user.id);
    if (existing.length >= MAX_PASSKEYS_PER_ACCOUNT) throw new AuthFailure('passkey-limit');

    const { ceremonyId, options } = await this.#parts.webauthn.registrationOptions({
      user: {
        handle: await this.#parts.passkeys.userHandle(user.id),
        email: user.email,
        name: user.name,
      },
      existing,
      binding: { userId: user.id, familyId: challengeId },
    });

    return { ceremonyId, options: { ...options } };
  }

  /**
   * The passkey half of {@link completeEnrolment}: what the authenticator made
   * turns the factor on, the challenge is spent, the recovery codes are drawn
   * (this is the account's first second factor) and the session the challenge
   * stood in for opens. A registration that does not verify costs an attempt
   * from the same budget as a wrong code.
   */
  async completePasskeyEnrolment({
    challengeId,
    ip,
    ceremonyId,
    response,
    name,
    userAgent,
  }: {
    readonly challengeId: string;
    readonly ip: string;
    readonly ceremonyId: string;
    readonly response: RegistrationResponse;
    readonly name: string;
    readonly userAgent: string | undefined;
  }): Promise<{ readonly recoveryCodes: string[]; readonly issued: IssuedSession }> {
    const { challenge, user, attempt } = await this.#signInChallenge(challengeId, 'enrolment', ip);
    await this.#assertPasskeyAllowed(challenge);
    const reserved = await this.#reserveAttempt(challengeId, challenge);

    let registered: Awaited<ReturnType<WebAuthnService['verifyRegistration']>>;
    try {
      registered = await this.#parts.webauthn.verifyRegistration({
        ceremonyId,
        binding: { userId: user.id, familyId: challengeId },
        response: toRegistrationJson(response),
      });
    } catch (error) {
      if (
        error instanceof AuthFailure &&
        (error.auth.code === 'challenge-expired' || error.auth.code === 'invalid-credentials')
      ) {
        await this.#audit('auth.second_factor.failed', user.id, 'system', {
          factor: 'passkey',
          during: 'enrolment',
          reason: error.auth.code,
        });
        throw await this.#failAttempt(challengeId, challenge, reserved, 'passkey-invalid');
      }
      throw error;
    }

    await this.#consumeChallenge(challengeId, user.id);
    const drawn = newRecoveryCodes();
    const hashes = await hashRecoveryCodes(drawn, this.#parts.hasher);
    const { passkeys, staff } = this.#parts;
    const stored = await passkeys.transaction(async (tx) => {
      // The same lock the security page's add and remove take.
      await passkeys.lockAccount(user.id, tx);
      const current = await staff.findById(user.id, tx);
      if (current === undefined || !this.#isUsable(current)) {
        throw new AuthFailure('challenge-expired');
      }
      const held = await passkeys.count(user.id, tx);
      // An enrolment challenge stands in for a session only while the account
      // has no second factor. One that was handed out earlier must not let a
      // first factor alone add a passkey beside a factor that has since been set.
      if (current.totpEnabled || held > 0) throw new AuthFailure('challenge-expired');

      const row = await passkeys.add(user.id, name, registered, tx);
      if (row === 'duplicate') throw new AuthFailure('passkey-duplicate');

      await staff.replaceRecoveryCodes(user.id, hashes, tx);
      return { row, recoveryCodes: drawn };
    });

    await this.#parts.challenges.clearLock(user.id);
    this.#parts.logger.info({ userId: user.id }, 'Enrolled a passkey as the second factor');
    await this.#audit('auth.passkey.added', user.id, 'staff', {
      passkey: stored.row.id,
      name: stored.row.name,
      synced: stored.row.backedUp,
      during: 'enrolment',
    });
    const client = currentRequestContext()?.client;
    await this.#notifySecurityChange(user.id, 'passkeyAdded', undefined, {
      passkey: stored.row.name,
      ...describeClient(client?.userAgent, client?.ip),
    });

    const issued = await this.#openSession(user, userAgent, {
      method: firstFactorOf(challenge),
      secondFactor: 'passkey',
    });
    await this.#parts.limiter.signInSucceeded(attempt);
    await this.#parts.challenges.clearFailures(user.id);

    return { recoveryCodes: stored.recoveryCodes, issued };
  }

  /**
   * Whether this account may be without a second factor. Never, for an Admin
   * of any brand or an install admin, whatever `auth.require2fa` says: their
   * session can change who else works here (ASVS 4.3.1, DOMAIN-RULES §12).
   */
  async isSecondFactorRequired(user: StaffUser, tx?: Queryable): Promise<boolean> {
    if (user.installAdmin || (await this.#parts.settings.get('auth.require2fa'))) {
      return true;
    }

    const memberships = await this.#parts.staff.membershipsOf(user.id, tx);
    return memberships.some((membership) => membership.role === 'admin');
  }

  /** {@link isSecondFactorRequired} by id, for the security page. */
  async secondFactorRequiredFor(userId: string, tx?: Queryable): Promise<boolean> {
    return this.isSecondFactorRequired(await this.#requireUser(userId, tx), tx);
  }

  /**
   * Turns the second factor off. A live code is the credential: somebody who
   * walked up to an unlocked laptop has the session but not the phone, and
   * without this they could remove the factor that would have stopped them.
   *
   * Refused while `auth.require2fa` is on, or for an account that must keep a
   * second factor anyway, unless a passkey remains to be that factor
   * (DOMAIN-RULES §12, §12.1).
   */
  async disableTotp(userId: string, code: string, tx?: DbTransaction): Promise<void> {
    // The lock passkey add and remove take. Without it, "remove the last
    // passkey" and "turn the app off" could each see the other factor still
    // there and leave an Admin with none.
    if (tx !== undefined) await this.#parts.passkeys.lockAccount(userId, tx);
    const passkeys = await this.#parts.passkeys.count(userId, tx);
    if (
      passkeys === 0 &&
      (await this.isSecondFactorRequired(await this.#requireUser(userId, tx), tx))
    ) {
      throw new AuthFailure('unavailable');
    }

    const user = await this.#requireLiveCode(userId, code, tx);

    // The recovery codes belong to the account's second factor, not to the app:
    // while a passkey remains they still answer a challenge.
    await this.#parts.staff.disableTotp(user.id, tx, { keepRecoveryCodes: passkeys > 0 });
    await this.#afterCommit(() => this.#parts.rotations.clearForUser(user.id));
    await this.#parts.trustedDevices.revokeAll(user.id);
    this.#parts.logger.warn({ userId: user.id }, 'Disabled the second factor for a staff account');
    await this.#audit('auth.second_factor.disabled', user.id, 'staff');
    await this.#notifySecurityChange(user.id, 'twoFactorDisabled', tx);
  }

  // ------------------------------------------------------------------
  // Replacing the authenticator app (#373)
  //
  // An account that must have a second factor and holds only the app can
  // neither turn it off (no factor would remain) nor enrol over it (one is
  // on), so a lost phone left no way to rotate. The rotation swaps the secret
  // in one confirmed step: a step-up proof starts it, the new app's code
  // finishes it, and the swap itself is one guarded UPDATE inside the request
  // transaction, so a failure anywhere keeps the old app working.
  // ------------------------------------------------------------------

  /**
   * Whether this account has an app that a rotation could replace. Checked
   * before any proof is spent, so a refusal costs no attempt — the same order
   * {@link disconnectOauth} keeps for its own cheap refusal.
   */
  async assertTotpRotatable(userId: string, tx?: Queryable): Promise<StaffUser> {
    const user = await this.#requireUser(userId, tx);
    if (!user.totpEnabled) {
      throw new AuthFailure('totp-not-enabled');
    }

    return user;
  }

  /** Whether this account may offer a recovery code to start a rotation; the page hides the option when not. */
  async recoveryCodeProofAllowed(userId: string, tx?: DbTransaction): Promise<boolean> {
    return !(await this.#parts.ssoPolicy.recoveryCodeBarred(
      await this.#requireUser(userId, tx),
      tx,
    ));
  }

  /**
   * Step 1 of the rotation, for every proof but a passkey: verify the step-up
   * (the current app's code, a recovery code, or the password with a recovery
   * code — DOMAIN-RULES §12.1) and stage a fresh secret. Nothing is replaced
   * until {@link confirmTotpRotation} verifies a code the new app produced, so
   * a scan that did not save cannot lock anybody out. The staged secret waits
   * in Redis, sealed, for fifteen minutes.
   *
   * A passkey proof is verified by `PasskeyService` first, which then calls
   * {@link stageTotpRotation} — the same hand-back `regenerateRecoveryCodes`
   * after a passkey takes.
   */
  async startTotpRotation({
    userId,
    proof,
    tx,
  }: {
    readonly userId: string;
    readonly proof: TotpRotationProof;
    readonly tx?: DbTransaction;
  }): Promise<TotpRotationStart> {
    // The lock disableTotp and regenerateRecoveryCodes take. A recovery code
    // is read, argon2-checked and rewritten here; unlocked, two starts could
    // spend one code twice, or write back codes a redraw had just replaced.
    if (tx !== undefined) await this.#parts.passkeys.lockAccount(userId, tx);
    const user = await this.assertTotpRotatable(userId, tx);
    await this.#requireRotationProof(user, proof, tx);

    return this.stageTotpRotation(userId, tx);
  }

  /** Stages the secret a confirmed rotation will swap in; the caller has proved the step-up. */
  async stageTotpRotation(userId: string, tx?: Queryable): Promise<TotpRotationStart> {
    const user = await this.assertTotpRotatable(userId, tx);
    const secret = newTotpSecret();
    const rotationId = await this.#parts.rotations.create({
      userId,
      secretEncrypted: encryptSecret(secret, this.#parts.keyring),
      replaces: replacedSecretDigest(user.totpSecretEncrypted ?? ''),
    });

    return {
      rotationId,
      secret,
      uri: totpUri({ secret, email: user.email, issuer: new URL(this.#parts.appUrl).host }),
    };
  }

  /**
   * Step 2: a live code from the *new* app swaps the secret, once, under the
   * account-row lock the other factor changes take. The staged code is checked
   * before anything is written, the swap is one UPDATE that refuses an account
   * whose app is no longer on, and the row joins the request's transaction —
   * so a failure anywhere leaves the old secret (and only the old secret) in
   * place. Each confirm costs the step-up budget, so the six digits cannot be
   * walked while the staged secret waits.
   */
  async confirmTotpRotation({
    userId,
    rotationId,
    code,
    tx,
  }: {
    readonly userId: string;
    readonly rotationId: string;
    readonly code: string;
    readonly tx?: DbTransaction;
  }): Promise<void> {
    // The lock disableTotp and the passkey changes take: the account must not
    // lose its last factor, or gain one, while the swap is being decided.
    if (tx !== undefined) await this.#parts.passkeys.lockAccount(userId, tx);
    await this.#spendStepUp(userId);

    const staged = await this.#parts.rotations.read(rotationId);
    // Gone, another account's, or the app it was to replace was turned off
    // while the staged secret waited: either way there is nothing to confirm.
    const current = await this.#requireUser(userId, tx);
    // Bound to the secret it was staged against: one started before the app
    // was replaced, or turned off and set up again, replaces nothing.
    if (
      staged.status !== 'ok' ||
      staged.rotation.userId !== userId ||
      !current.totpEnabled ||
      current.totpSecretEncrypted === null ||
      replacedSecretDigest(current.totpSecretEncrypted) !== staged.rotation.replaces
    ) {
      throw new AuthFailure('challenge-expired');
    }

    let secret: string | null = null;
    try {
      secret = decryptSecret(staged.rotation.secretEncrypted, this.#parts.keyring);
    } catch (error) {
      // As with a stored secret that will not open: an operator problem, said
      // in the log, not a "wrong code" the person is blamed for.
      this.#parts.logger.error(
        { err: error, userId },
        'Could not decrypt a staged TOTP secret; check APP_MASTER_KEY and DOMAIN-RULES §10',
      );
    }
    // The staged secret — never the live one — decides the code, so the old
    // app cannot confirm its own replacement. The used-step record is not
    // consulted here on purpose: the code that proves the new app is frequently
    // on the same time step as the code that proved the old one, which the
    // record cannot tell apart, and this confirmation is its own single-use
    // context — the staged record is spent below, so a replayed request finds
    // nothing to confirm.
    const step = secret === null ? null : await matchTotpStep({ secret, code });
    if (step === null) {
      await this.#audit('auth.second_factor.failed', userId, 'system', {
        factor: 'totp',
        during: 'rotation',
      });
      throw new AuthFailure('totp-mismatch');
    }

    const rotated = await this.#parts.staff.rotateTotpSecret(
      userId,
      current.totpSecretEncrypted,
      staged.rotation.secretEncrypted,
      tx,
    );
    if (!rotated) {
      throw new AuthFailure('challenge-expired');
    }

    // After the commit, so a rollback neither spends the rotation nor marks a
    // code used for a secret that never took. The record is overwritten, not
    // claimed: the old one belongs to the secret just replaced and may sit on
    // this very time step. Marking the confirm code's own step used is what
    // stops it from signing in again straight afterwards.
    await this.#afterCommit(async () => {
      await this.#parts.rotations.clearForUser(userId);
      await this.#parts.steps.record(userId, step);
    });
    this.#parts.logger.info({ userId }, 'Replaced the authenticator app of a staff account');
    await this.#audit('auth.second_factor.rotated', userId, 'staff');
    await this.#notifySecurityChange(userId, 'twoFactorRotated', tx);
  }

  /** The proof matrix of DOMAIN-RULES §12.1 for a rotation: one of four, each spent where checked. */
  async #requireRotationProof(
    user: StaffUser,
    proof: TotpRotationProof,
    tx?: DbTransaction,
  ): Promise<void> {
    if (proof.code !== undefined) {
      await this.#requireLiveCode(user.id, proof.code, tx);
      return;
    }

    if (proof.recoveryCode !== undefined) {
      // Before any attempt is spent: a break-glass account under enforcement
      // proves with its app or a passkey, as ADR 0053 keeps recovery codes out
      // of break-glass and this would install its next factor.
      if (await this.#parts.ssoPolicy.recoveryCodeBarred(user, tx)) {
        throw new AuthFailure('recovery-code-not-allowed');
      }
      // Two recovery-code shapes, each a complete proof of its own (DOMAIN-RULES
      // §12.1 rule 7): the shape that also names the password has both halves
      // checked inside its helper, and the bare shape spends the code inside
      // its own — so whichever door the caller picks, it is locked the same way.
      if (proof.currentPassword !== undefined) {
        await this.#requirePasswordAndRecoveryCode(
          user,
          proof.currentPassword,
          proof.recoveryCode,
          tx,
        );
      } else {
        await this.#requireRecoveryCodeAlone(user, proof.recoveryCode, tx);
      }
      return;
    }

    // Unreachable through the schema, which allows a bare password nowhere:
    // this names the shape that is missing rather than failing later.
    throw new AuthFailure('invalid-credentials');
  }

  /**
   * The recovery-code shape with both halves: the current password and the
   * code. Both are verified on every call — a null hash and a wrong password
   * refuse identically — so one wrong half refuses the whole proof.
   */
  async #requirePasswordAndRecoveryCode(
    user: StaffUser,
    currentPassword: string,
    recoveryCode: string,
    tx?: DbTransaction,
  ): Promise<void> {
    await this.#spendStepUp(user.id);

    if (
      user.passwordHash === null ||
      !(await this.#parts.hasher.verify(user.passwordHash, currentPassword)).valid
    ) {
      await this.#audit('auth.step_up.refused', user.id, 'system', { reason: 'wrong-password' });
      throw new AuthFailure('invalid-credentials');
    }

    await this.#spendRecoveryCodeAsProof(user, recoveryCode, tx);
  }

  /** The bare recovery-code shape: the spent code is the whole proof. */
  async #requireRecoveryCodeAlone(
    user: StaffUser,
    recoveryCode: string,
    tx?: DbTransaction,
  ): Promise<void> {
    await this.#spendStepUp(user.id);
    await this.#spendRecoveryCodeAsProof(user, recoveryCode, tx);
  }

  /**
   * Spends the code exactly as one spent to sign in is — every hash is tried,
   * the remainder is stored, the use is audited — because it *is* a credential:
   * a rotation is worth one recovery code as much as a sign-in is.
   */
  async #spendRecoveryCodeAsProof(
    user: StaffUser,
    recoveryCode: string,
    tx?: DbTransaction,
  ): Promise<void> {
    const match = await spendRecoveryCode(
      recoveryCode,
      user.recoveryCodesHashed,
      this.#parts.hasher,
    );
    if (match === null) {
      await this.#audit('auth.second_factor.failed', user.id, 'system', {
        factor: 'recovery-code',
        during: 'step-up',
      });
      throw new AuthFailure('recovery-invalid');
    }

    await this.#parts.staff.replaceRecoveryCodes(user.id, match.remaining, tx);
    this.#parts.logger.warn(
      { userId: user.id, remaining: match.remaining.length },
      'A recovery code was spent to prove a credential change',
    );
    await this.#audit('auth.recovery_code.used', user.id, 'staff', {
      remaining: match.remaining.length,
      during: 'step-up',
    });
  }

  /**
   * Draws ten new recovery codes and forgets the old ones, once a live code has
   * proved the authenticator is still in hand. Regenerating without that proof
   * would be a way to mint a working credential from a stolen session.
   */
  async regenerateRecoveryCodes(
    userId: string,
    code: string,
    tx?: DbTransaction,
  ): Promise<RecoveryCodes> {
    // The lock disableTotp and the passkey redraw take: the codes belong to the
    // factors, so they are not redrawn while one is being removed.
    if (tx !== undefined) await this.#parts.passkeys.lockAccount(userId, tx);
    return this.#redrawRecoveryCodes(await this.#requireLiveCode(userId, code, tx), 'code', tx);
  }

  /**
   * The other proof that may redraw the codes: an assertion from a passkey the
   * account holds, which the caller (`PasskeyService`) has verified against the
   * step-up ceremony of this session (M18-03).
   */
  async regenerateRecoveryCodesAfterPasskey(
    userId: string,
    tx: DbTransaction,
  ): Promise<RecoveryCodes> {
    return this.#redrawRecoveryCodes(await this.#requireUser(userId, tx), 'passkey', tx);
  }

  async #redrawRecoveryCodes(
    user: StaffUser,
    proof: 'code' | 'passkey',
    tx?: DbTransaction,
  ): Promise<RecoveryCodes> {
    if (!(await this.hasSecondFactor(user, tx))) {
      throw new AuthFailure('unavailable');
    }
    const recoveryCodes = newRecoveryCodes();

    await this.#parts.staff.replaceRecoveryCodes(
      user.id,
      await hashRecoveryCodes(recoveryCodes, this.#parts.hasher),
      tx,
    );
    this.#parts.logger.info({ userId: user.id }, 'Redrew the recovery codes of a staff account');
    await this.#audit('auth.recovery_codes.regenerated', user.id, 'staff', { proof });
    await this.#notifySecurityChange(user.id, 'recoveryCodes', tx);

    return { recoveryCodes };
  }

  /** Forgets the codes of an account whose last second factor has just gone. */
  async clearRecoveryCodes(userId: string, tx: DbTransaction): Promise<void> {
    await this.#parts.staff.replaceRecoveryCodes(userId, [], tx);
  }

  /** TOTP enabled, or at least one passkey (DOMAIN-RULES §12.1 rule 2). */
  async hasSecondFactor(user: StaffUser, tx?: Queryable): Promise<boolean> {
    return user.totpEnabled || (await this.#parts.passkeys.count(user.id, tx)) > 0;
  }

  /**
   * Ten recovery codes for the account's first second factor, stored and handed
   * back once. The caller holds the account's lock and decides it is the first.
   */
  async issueRecoveryCodes(userId: string, tx: DbTransaction): Promise<string[]> {
    const recoveryCodes = newRecoveryCodes();
    await this.#parts.staff.replaceRecoveryCodes(
      userId,
      await hashRecoveryCodes(recoveryCodes, this.#parts.hasher),
      tx,
    );
    return recoveryCodes;
  }

  /**
   * A password change from inside a session. The current password is asked for
   * because the session alone is not proof that the person at the keyboard is
   * the account holder, and every *other* family is revoked afterwards for the
   * same reason a reset revokes them all — except this one, so the person who
   * just changed it is not thrown out of the screen they did it on.
   */
  async changePassword({
    userId,
    currentPassword,
    newPassword,
    keepFamilyId,
    tx,
  }: {
    readonly userId: string;
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly keepFamilyId: string | null;
    readonly tx?: DbTransaction;
  }): Promise<void> {
    const user = await this.#requireCurrentPassword(userId, currentPassword, tx);
    assertNotBreached(newPassword);

    await this.#parts.staff.updatePasswordHash(
      user.id,
      await this.#parts.hasher.hash(newPassword),
      tx,
    );
    await this.#parts.trustedDevices.revokeAll(user.id);
    const revoked = await this.#parts.sessions.revokeEverythingExcept(
      user.id,
      keepFamilyId,
      'password-change',
    );

    this.#parts.logger.info({ userId: user.id, revoked }, 'A staff account changed its password');
    await this.#audit('auth.password.changed', user.id, 'staff', { sessionsRevoked: revoked });
    await this.#notifySecurityChange(user.id, 'password', tx);
  }

  /**
   * Hashes a password for a module that has no business holding the pepper.
   * M0-06's invite acceptance sets the first password an account ever has, and
   * it must be the same argon2 parameters under the same pepper as every other
   * one — a second hasher built beside this one is a second pepper, and half
   * the hashes in the table would stop verifying.
   */
  hashPassword(password: string): Promise<string> {
    assertNotBreached(password);
    return this.#parts.hasher.hash(password);
  }

  /**
   * Signs in an account that has just accepted its invitation. There is no
   * credential to check here because the invite token was the credential and
   * the caller has already spent it — exactly as a magic link works — so this
   * joins the same path every other first factor ends on, second factor and
   * enrolment requirement included.
   */
  async signInAfterInvite(userId: string, userAgent: string | undefined): Promise<SignInOutcome> {
    const user = await this.#requireUser(userId);

    return this.#afterFirstFactor(user, {
      method: 'invite',
      userAgent,
      trustedDeviceCookie: undefined,
    });
  }

  /**
   * Queues one invite message in the staff route's own transaction, so an
   * invitation that rolls back sends nothing. The staff service owns the
   * token; this owns the envelope.
   */
  async queueInvite(tx: DbTransaction, brandId: string, input: InviteEmailInput): Promise<void> {
    await this.#parts.mail.queue(tx, brandId, {
      kind: 'invite',
      userId: input.userId,
      url: input.url,
      expiresIn: input.expiresInDays,
      values: {
        inviter: input.inviterName,
        brandName: input.brandName,
        role: input.roleName,
      },
    });
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
    // First: with SSO enforced there is no link to send, whatever the sender.
    if (await this.#parts.ssoPolicy.enforced()) throw new AuthFailure('sso-required');
    await this.#assertSenderCanSend();
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
      userId: user.id,
      url: magicLinkScreenUrl(this.#parts.appUrl, token),
      expiresIn: minutes,
    });
  }

  /**
   * What the confirm screen shows before the click: whose account the link
   * opens. Reading spends nothing, so a mail scanner or a link preview that
   * fetches the page leaves the link working (M9-01 F6).
   *
   * Only a live link gets an answer, and every dead one gets the same one, so
   * this cannot be asked about an address.
   */
  async previewMagicLink({
    token,
    ip,
  }: {
    readonly token: string;
    readonly ip: string;
  }): Promise<MagicLinkPreview> {
    await this.#assertMagicLinkAllowed(ip);
    const user = await this.#magicLinkUser(await this.#parts.tokens.read(token, 'magic-link'));
    if (user === undefined) {
      throw new AuthFailure('challenge-expired');
    }

    return {
      email: user.email,
      expiresInMinutes: await this.#parts.settings.get('auth.magicLinkTtlMinutes'),
    };
  }

  /** Spends the link on the person's click. The second factor still applies afterwards. */
  async consumeMagicLink({
    token,
    ip,
    userAgent,
  }: {
    readonly token: string;
    readonly ip: string;
    readonly userAgent: string | undefined;
  }): Promise<SignInOutcome> {
    await this.#assertMagicLinkAllowed(ip);
    const payload = await this.#parts.tokens.consume(token, 'magic-link');
    const user = await this.#magicLinkUser(payload);
    if (user === undefined) {
      await this.#audit('auth.sign_in.failed', payload?.userId ?? null, 'system', {
        method: 'magic-link',
        reason: payload === null ? 'invalid-link' : 'unusable-account',
      });
      throw new AuthFailure('challenge-expired');
    }

    return this.#afterFirstFactor(user, {
      method: 'magic-link',
      userAgent,
      trustedDeviceCookie: undefined,
    });
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
    await this.#assertSenderCanSend();
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
      userId: user.id,
      url: new URL(
        `/sign-in/reset?token=${encodeURIComponent(token)}`,
        this.#parts.appUrl,
      ).toString(),
      expiresIn: PASSWORD_RESET_TTL_MINUTES,
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
    // Before the link is spent, so a refused password leaves the person a link
    // that still works for a better one.
    assertNotBreached(password);
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
    await this.#audit('auth.password.reset', user.id, 'staff');
    // A reset proves the mailbox, not the person, so it never removes a
    // passkey (DOMAIN-RULES §12.1); the notice says how many remain, so the
    // holder can remove any they do not recognise.
    const passkeys = await this.#parts.passkeys.count(user.id);
    await this.#notifySecurityChange(
      user.id,
      'passwordReset',
      undefined,
      passkeys > 0 ? { passkeys: String(passkeys) } : {},
    );
  }

  // ------------------------------------------------------------------
  // OAuth
  // ------------------------------------------------------------------

  async startOauth(provider: OauthProvider): Promise<{ url: string; browserNonce: string }> {
    if (await this.#parts.ssoPolicy.enforced()) throw new AuthFailure('sso-required');
    try {
      return await this.#parts.oauth.start(provider);
    } catch (error) {
      this.#parts.logger.warn({ err: error, provider }, 'Could not start an OAuth flow');
      throw new AuthFailure('unavailable');
    }
  }

  /**
   * The callback of either flow. A flow a signed-in person started to connect
   * a provider links it to them; any other is a sign-in, bound by the provider
   * account's subject (`oauth-linking.ts`). No account is created: owning a
   * Google address is not a reason to be staff here.
   */
  async completeOauth({
    provider,
    code,
    state,
    browserNonce,
    userAgent,
  }: {
    readonly provider: OauthProvider;
    readonly code: string;
    readonly state: string;
    readonly browserNonce: string | undefined;
    readonly userAgent: string | undefined;
  }): Promise<OauthCallbackOutcome> {
    let completion: Awaited<ReturnType<OauthService['complete']>>;
    try {
      completion = await this.#parts.oauth.complete({ provider, code, state, browserNonce });
    } catch (error) {
      this.#parts.logger.warn({ err: error, provider }, 'An OAuth callback could not be completed');
      if (error instanceof OauthError && error.reason === 'tenant-mismatch') {
        await this.#audit('auth.sign_in.failed', null, 'system', {
          method: 'oauth',
          provider,
          reason: 'tenant-mismatch',
        });
        throw new AuthFailure('oauth-tenant-mismatch');
      }
      throw new AuthFailure(error instanceof OauthError ? 'no-account' : 'unavailable');
    }

    if (completion.linkUserId !== undefined) {
      await this.#connectOauth(completion.linkUserId, completion.identity);
      return { kind: 'connected' };
    }
    if (completion.invite !== undefined) {
      return this.#acceptInviteWithOauth(completion.invite, completion.identity, userAgent);
    }
    return this.#signInWithOauth(completion.identity, userAgent);
  }

  /** Called once, by the staff module, which owns invitations (see {@link OauthInviteAcceptor}). */
  acceptInvitesWith(acceptor: OauthInviteAcceptor): void {
    this.#inviteAcceptor = acceptor;
  }

  /**
   * Starts accepting an invitation with a provider (M18-07). The caller has
   * read the invitation; the flow's state carries its token's hash, never the
   * token, and the name and language the person typed.
   */
  async startInviteOauth(
    provider: OauthProvider,
    invite: OauthInviteState,
  ): Promise<{ url: string; browserNonce: string }> {
    if (await this.#parts.ssoPolicy.enforced()) throw new AuthFailure('sso-required');
    try {
      return await this.#parts.oauth.start(provider, { invite });
    } catch (error) {
      this.#parts.logger.warn({ err: error, provider }, 'Could not start an invitation OAuth flow');
      throw new AuthFailure('unavailable');
    }
  }

  /**
   * Binds the provider account an invitation was accepted with, in the
   * acceptance's own transaction, with its security email in the same
   * transaction's outbox: the invitation token already proved the mailbox, so
   * no step-up is asked (DOMAIN-RULES §12, "sets password or OAuth link"). The
   * audit row is written by {@link recordInvitedLink} once that transaction
   * has committed, because the trail writes in a transaction of its own and a
   * rolled-back acceptance must leave no `auth.oauth.linked` behind.
   */
  async linkInvitedIdentity(
    tx: DbTransaction,
    userId: string,
    identity: OauthIdentity,
  ): Promise<void> {
    await this.#bindIdentity(userId, identity, 'invite', tx);
  }

  /** The audit half of {@link linkInvitedIdentity}, after the acceptance committed. */
  async recordInvitedLink(userId: string, provider: OauthProvider): Promise<void> {
    await this.#auditLinked(userId, provider, 'invite');
  }

  /**
   * The callback half of an invitation accepted with a provider. Refusals that
   * do not depend on the invitation come first: the allowed domains, and a
   * provider account that already signs in as somebody else.
   */
  async #acceptInviteWithOauth(
    invite: OauthInviteState,
    identity: OauthIdentity,
    userAgent: string | undefined,
  ): Promise<OauthCallbackOutcome> {
    const { provider } = identity;
    if (!(await this.#domainAllowed(identity))) {
      await this.#audit('auth.sign_in.failed', null, 'system', {
        method: 'invite',
        provider,
        reason: 'domain-not-allowed',
      });
      throw new AuthFailure('oauth-domain-not-allowed');
    }
    const boundTo = await this.#parts.oauthIdentities.userFor(provider, identity.subject);
    if (boundTo !== undefined) {
      await this.#audit('auth.sign_in.failed', boundTo, 'system', {
        method: 'invite',
        provider,
        reason: 'identity-conflict',
      });
      throw new AuthFailure('oauth-identity-conflict');
    }
    if (this.#inviteAcceptor === undefined) {
      throw new AuthFailure('unavailable');
    }
    return this.#inviteAcceptor.acceptWithProvider({ invite, identity, userAgent });
  }

  /**
   * The provider accounts that sign in as this person, for their security
   * page, and whether they also have a password: the page needs both to say
   * which provider is their last way in.
   */
  async oauthIdentities(userId: string, tx?: Queryable): Promise<OauthIdentityList> {
    const user = await this.#requireUser(userId, tx);
    const rows = await this.#parts.oauthIdentities.ofUser(userId, tx);
    return {
      identities: rows.map((row) => ({
        provider: row.provider,
        email: row.emailAtLink,
        connectedAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      })),
      passwordSet: user.passwordHash !== null,
    };
  }

  /**
   * Starts a flow that connects `provider` to the signed-in account, once the
   * person has proved the password or a live code again: a stolen session
   * must not be able to add a way in. The callback links whichever provider
   * account the browser comes back with.
   */
  async startOauthConnect({
    userId,
    provider,
    proof,
    tx,
  }: {
    readonly userId: string;
    readonly provider: OauthProvider;
    readonly proof: OauthStepUpRequest;
    readonly tx?: DbTransaction;
  }): Promise<{ url: string; browserNonce: string }> {
    if (await this.#parts.ssoPolicy.enforced(tx)) throw new AuthFailure('sso-required');
    await this.#requireStepUp(userId, proof, tx);
    if (await this.#hasLiveIdentity(userId, provider, tx)) {
      throw new AuthFailure('oauth-identity-conflict');
    }
    try {
      return await this.#parts.oauth.start(provider, { linkUserId: userId });
    } catch (error) {
      this.#parts.logger.warn({ err: error, provider }, 'Could not start an OAuth connect flow');
      throw new AuthFailure('unavailable');
    }
  }

  /**
   * Removes a provider account from the signed-in account, behind the same
   * step-up. Refused before the step-up when it is the account's last way in
   * (no password and no other provider), so the refusal spends no attempt.
   */
  async disconnectOauth({
    userId,
    provider,
    proof,
    tx,
  }: {
    readonly userId: string;
    readonly provider: OauthProvider;
    readonly proof: OauthStepUpRequest;
    readonly tx?: DbTransaction;
  }): Promise<void> {
    if (isLastSignInMethod(await this.oauthIdentities(userId, tx), provider)) {
      throw new AuthFailure('oauth-last-sign-in');
    }
    await this.#requireStepUp(userId, proof, tx);
    const removed = await this.#parts.oauthIdentities.unlink(userId, provider, tx);
    if (removed === undefined) {
      return;
    }
    this.#parts.logger.info({ userId, provider }, 'Disconnected a sign-in provider account');
    await this.#audit('auth.oauth.unlinked', userId, 'staff', { provider });
    await this.#notifySecurityChange(userId, 'oauthDisconnected', tx, {
      provider: PROVIDER_NAMES[provider],
      account: removed.emailAtLink,
    });
  }

  async #signInWithOauth(
    identity: OauthIdentity,
    userAgent: string | undefined,
  ): Promise<SignInOutcome> {
    const { provider } = identity;
    await this.#parts.ssoPolicy.assertLocal(identity.email, 'oauth');
    const linkedUserId = await this.#parts.oauthIdentities.userFor(provider, identity.subject);
    if (!(await this.#domainAllowed(identity))) {
      await this.#audit('auth.sign_in.failed', linkedUserId ?? null, 'system', {
        method: 'oauth',
        provider,
        reason: 'domain-not-allowed',
      });
      throw new AuthFailure('oauth-domain-not-allowed');
    }
    const decision = decideOauthSignIn({
      linkedUserId,
      authoritative: identity.authoritative,
      emailMatch: linkedUserId === undefined ? await this.#emailMatchFor(identity) : undefined,
    });
    if (decision.kind === 'refuse') {
      await this.#audit('auth.sign_in.failed', decision.userId, 'system', {
        method: 'oauth',
        provider,
        reason: decision.reason,
      });
      throw new AuthFailure(decision.code);
    }

    const user = await this.#parts.staff.findById(decision.userId);
    if (user === undefined || !this.#isUsable(user)) {
      await this.#audit('auth.sign_in.failed', decision.userId, 'system', {
        method: 'oauth',
        provider,
        reason: 'unusable-account',
      });
      throw new AuthFailure('no-account');
    }
    if (decision.link) {
      await this.#linkOauth(user.id, identity, 'sign-in');
    } else {
      await this.#parts.oauthIdentities.markUsed(provider, identity.subject);
    }

    return this.#afterFirstFactor(user, {
      method: 'oauth',
      userAgent,
      trustedDeviceCookie: undefined,
    });
  }

  /** Who holds the address the provider reported, and whether they already have one of its accounts. */
  async #emailMatchFor(
    identity: OauthIdentity,
  ): Promise<{ userId: string; hasProviderIdentity: boolean } | undefined> {
    const matched = await this.#parts.staff.findByEmail(identity.email);
    if (matched === undefined) {
      return undefined;
    }
    return {
      userId: matched.id,
      hasProviderIdentity: await this.#hasLiveIdentity(matched.id, identity.provider),
    };
  }

  /**
   * Whether the person has a provider account that can still sign in. A
   * Microsoft identity bound to a tenant the install no longer accepts cannot,
   * and does not block a new link: it is replaced when the new one is made.
   */
  async #hasLiveIdentity(
    userId: string,
    provider: OauthProvider,
    tx?: DbTransaction,
  ): Promise<boolean> {
    const rows = await this.#parts.oauthIdentities.ofUser(userId, tx);
    const own = rows.filter((row) => row.provider === provider);
    if (provider !== 'microsoft' || own.length === 0) {
      return own.length > 0;
    }
    const accepted = await this.#acceptedMicrosoftTenants();
    return own.some((row) => accepted.includes(row.providerSubject.split(':')[0] ?? ''));
  }

  /** The pinned tenant, and the consumers tenant while personal accounts are allowed. */
  async #acceptedMicrosoftTenants(): Promise<string[]> {
    const [tenantId, allowConsumers] = await Promise.all([
      this.#parts.settings.get('oauth.microsoft.tenantId'),
      this.#parts.settings.get('oauth.microsoft.allowConsumers'),
    ]);
    return tenantId === ''
      ? []
      : [tenantId, ...(allowConsumers ? [MICROSOFT_CONSUMERS_TENANT_ID] : [])];
  }

  /**
   * Replaces a stranded Microsoft identity (a tenant the install stopped
   * accepting) in one transaction with the audit row and the "connected" email.
   * True when it did; false when the person has none, so the caller links as
   * usual. A still-accepted one stays a conflict.
   */
  async #replaceStrandedMicrosoft(
    userId: string,
    identity: OauthIdentity,
    via: OauthLinkedVia,
  ): Promise<boolean> {
    if (identity.provider !== 'microsoft') {
      return false;
    }
    const [brandId] = (await this.#parts.staff.membershipsOf(userId))
      .map((membership) => membership.brandId)
      .sort();
    if (brandId === undefined) {
      return false;
    }

    const outcome = await this.#parts.oauthIdentities.replaceStrandedMicrosoft({
      link: {
        userId,
        provider: 'microsoft',
        subject: identity.subject,
        email: identity.email,
        via,
      },
      acceptedTenants: await this.#acceptedMicrosoftTenants(),
      brandId,
      afterReplace: (tx) =>
        this.#parts.mail.queue(
          tx,
          brandId,
          this.#securityChangeRequest(userId, 'oauthConnected', {
            provider: PROVIDER_NAMES.microsoft,
            account: identity.email,
          }),
        ),
    });
    if (outcome === 'conflict') {
      await this.#audit('auth.oauth.link_refused', userId, 'system', {
        provider: 'microsoft',
        via,
      });
      throw new AuthFailure('oauth-identity-conflict');
    }
    if (outcome === 'replaced') {
      this.#parts.logger.info({ userId, via }, 'Replaced a stranded Microsoft sign-in account');
    }

    return outcome === 'replaced';
  }

  /** The callback half of {@link startOauthConnect}. */
  async #connectOauth(userId: string, identity: OauthIdentity): Promise<void> {
    if (await this.#parts.ssoPolicy.enforced()) throw new AuthFailure('sso-required');
    const user = await this.#requireUser(userId);
    if (!(await this.#domainAllowed(identity))) {
      await this.#audit('auth.oauth.link_refused', user.id, 'staff', {
        provider: identity.provider,
        via: 'connect',
        reason: 'domain-not-allowed',
      });
      throw new AuthFailure('oauth-domain-not-allowed');
    }
    await this.#linkOauth(user.id, identity, 'connect');
  }

  /** `oauth.google.allowedDomains` (ADR 0051); the other providers have no such list. */
  async #domainAllowed(identity: OauthIdentity): Promise<boolean> {
    if (identity.provider !== 'google') {
      return true;
    }
    return googleDomainAllowed({
      hostedDomain: identity.hostedDomain,
      allowedDomains: await this.#parts.settings.get('oauth.google.allowedDomains'),
    });
  }

  /**
   * Binds the provider account, audits it, and tells the account holder: a new
   * way into their account is a change they must hear about (ASVS 2.5.5).
   */
  async #linkOauth(userId: string, identity: OauthIdentity, via: OauthLinkedVia): Promise<void> {
    await this.#bindIdentity(userId, identity, via);
    await this.#auditLinked(userId, identity.provider, via);
  }

  /** The link itself and the holder's email, in `tx` when the caller has one. */
  async #bindIdentity(
    userId: string,
    identity: OauthIdentity,
    via: OauthLinkedVia,
    tx?: DbTransaction,
  ): Promise<void> {
    const { provider } = identity;
    if (tx === undefined && (await this.#replaceStrandedMicrosoft(userId, identity, via))) {
      return;
    }
    const linked = await this.#parts.oauthIdentities.link(
      { userId, provider, subject: identity.subject, email: identity.email, via },
      tx,
    );
    if (linked === 'conflict') {
      await this.#audit('auth.oauth.link_refused', userId, 'system', { provider, via });
      throw new AuthFailure('oauth-identity-conflict');
    }

    this.#parts.logger.info({ userId, provider, via }, 'Connected a sign-in provider account');
    await this.#notifySecurityChange(userId, 'oauthConnected', tx, {
      provider: PROVIDER_NAMES[provider],
      account: identity.email,
    });
  }

  #auditLinked(userId: string, provider: OauthProvider, via: OauthLinkedVia): Promise<void> {
    return this.#audit('auth.oauth.linked', userId, via === 'sign-in' ? 'system' : 'staff', {
      provider,
      via,
    });
  }

  async completeSso(
    assertion: SsoAssertion,
    userAgent: string | undefined,
  ): Promise<SignInOutcome> {
    const { user, idpEnforcesMfa } = await this.#parts.sso.signIn(
      ssoAssertionSchema.parse(assertion),
    );
    if (idpEnforcesMfa)
      return {
        kind: 'session',
        issued: await this.#openSession(user, userAgent, { method: 'sso', secondFactor: 'idp' }),
      };
    return this.#afterFirstFactor(user, {
      method: 'sso',
      ssoConnectionId: assertion.connectionId,
      userAgent,
      trustedDeviceCookie: undefined,
    });
  }

  async assertLocalSignInAllowed(email: string, method: string): Promise<void> {
    await this.#parts.ssoPolicy.assertLocal(email, method);
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
    await this.revokeAllAccess(userId, 'sign-out-everywhere');
  }

  /**
   * Everything this account can get back in with, gone: every family, and every
   * browser it trusted. M0-06 calls it on deactivation, where the same
   * reasoning applies with more force — a deactivated person must not keep a
   * browser that skips the second factor (DOMAIN-RULES §12).
   */
  async revokeAllAccess(userId: string, reason: string): Promise<number> {
    await this.#parts.trustedDevices.revokeAll(userId);
    const revoked = await this.#parts.sessions.revokeEverything(userId, reason);

    this.#parts.logger.info(
      { userId, revoked, reason },
      'Revoked every session of a staff account',
    );

    return revoked;
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
      method,
      userAgent,
      trustedDeviceCookie,
      ssoConnectionId,
    }: {
      readonly method: SignInMethod;
      readonly ssoConnectionId?: string;
      readonly userAgent: string | undefined;
      readonly trustedDeviceCookie: string | undefined;
    },
  ): Promise<SignInOutcome> {
    if (method !== 'sso') await this.#parts.ssoPolicy.assertLocal(user.email, method);
    const passkeyCount = await this.#parts.passkeys.count(user.id);
    if (user.totpEnabled || passkeyCount > 0) {
      if (
        (await this.#parts.ssoPolicy.allows(method, 'trusted-browser')) &&
        (await this.#parts.trustedDevices.isTrusted(user.id, trustedDeviceCookie))
      ) {
        return {
          kind: 'session',
          issued: await this.#openSession(user, userAgent, {
            method,
            secondFactor: 'trusted-browser',
          }),
        };
      }

      return {
        kind: 'totp-required',
        challengeId: await this.#parts.challenges.create({
          userId: user.id,
          kind: 'second-factor',
          firstFactor: method,
          ...(ssoConnectionId === undefined ? {} : { ssoConnectionId }),
        }),
        email: user.email,
        factors: await this.#factorsOf(user, passkeyCount, method),
      };
    }

    // An Admin who had no second factor before the rule existed lands here at
    // their next sign-in, and enrols before they get a session.
    if (await this.isSecondFactorRequired(user)) {
      return {
        kind: 'second-factor-enrolment-required',
        challengeId: await this.#parts.challenges.create({
          userId: user.id,
          kind: 'enrolment',
          firstFactor: method,
          ...(ssoConnectionId === undefined ? {} : { ssoConnectionId }),
        }),
      };
    }

    return {
      kind: 'session',
      issued: await this.#openSession(user, userAgent, { method, secondFactor: null }),
    };
  }

  async #openSession(
    user: StaffUser,
    userAgent: string | undefined,
    factors: { readonly method: string; readonly secondFactor: string | null },
  ): Promise<IssuedSession> {
    if (factors.method !== 'sso') {
      await this.#parts.ssoPolicy.assertLocal(user.email, factors.method);
    }
    await this.#parts.ssoPolicy.assertAllowed(factors.method, factors.secondFactor);
    // An invited account becomes active the first time it proves an identity
    // (DOMAIN-RULES §12).
    if (user.status === 'invited') {
      if (factors.method === 'sso') await this.#parts.sso.acceptInvitation(user.id);
      else await this.#parts.staff.markActive(user.id);
    }

    const issued = await this.#parts.sessions.open({
      userId: user.id,
      userAgent,
      ...(factors.method === 'sso' ? { maxAgeSeconds: 12 * 3600 } : {}),
    });
    if (issued === null) {
      // Nothing to sign in to: this account holds no role in any brand.
      await this.#audit('auth.sign_in.failed', user.id, 'system', {
        method: factors.method,
        reason: 'no-brand-role',
      });
      throw new AuthFailure('no-account');
    }

    await this.#audit('auth.sign_in.succeeded', user.id, 'staff', {
      method: factors.method,
      secondFactor: factors.secondFactor,
      familyId: issued.refreshCookieValue.fam,
    });

    return issued;
  }

  /** What a second-factor screen may offer this account right now. */
  async #factorsOf(
    user: StaffUser,
    passkeyCount: number,
    method: SignInMethod,
  ): Promise<SecondFactorOptions> {
    // A passkey the install cannot use at the moment (its address moved) is
    // hidden only where an authenticator app can stand in for it.
    const usable = !user.totpEnabled || (await this.#parts.webauthn.status()).state === 'available';
    // Offer only what verify accepts under the current enforcement.
    return {
      totp: user.totpEnabled && (await this.#parts.ssoPolicy.allows(method, 'totp')),
      passkey:
        passkeyCount > 0 && usable && (await this.#parts.ssoPolicy.allows(method, 'passkey')),
    };
  }

  /**
   * Checks a second-factor assertion, auditing every refusal under one reason
   * of its own. A ceremony that is gone (spent, expired, or minted for another
   * challenge) is a refusal here, not an expired challenge: the person can ask
   * for fresh options, and a replay must cost an attempt.
   */
  async #checkAssertion(
    user: StaffUser,
    purpose: 'second-factor' | 'break-glass',
    ceremonyId: string,
    challengeId: string,
    response: AuthenticationResponse,
  ): Promise<Extract<AssertionCheck, { ok: true }> | { readonly ok: false }> {
    let presented: string | undefined;
    let check: AssertionCheck | { readonly ok: false; readonly reason: 'ceremony-gone' };
    try {
      check = await this.#parts.webauthn.verifyAuthentication({
        purpose,
        binding: { userId: user.id, familyId: challengeId },
        ceremonyId,
        response: toAuthenticationJson(response),
        findCredential: async (credentialId) => {
          const row = await this.#parts.passkeys.byCredentialId(credentialId);
          presented = row?.id;
          return row === undefined ? undefined : toStored(row);
        },
      });
    } catch (error) {
      if (!(error instanceof AuthFailure) || error.auth.code !== 'challenge-expired') throw error;
      check = { ok: false, reason: 'ceremony-gone' };
    }

    if (check.ok) return check;
    await this.#audit('auth.second_factor.failed', user.id, 'system', {
      factor: 'passkey',
      reason: check.reason,
    });
    if (check.reason === 'counter-regressed') {
      await this.#audit('auth.passkey.counter_regressed', user.id, 'system', {
        passkey: presented,
      });
    }
    return { ok: false };
  }

  /**
   * Under SSO enforcement a passkey answers only a challenge that followed an
   * SSO assertion (the IdP is the first factor) or a break-glass password
   * (ADR 0053), and anything else is refused before it costs an attempt or
   * mints a ceremony.
   */
  async #assertPasskeyAllowed(
    found: Awaited<ReturnType<TotpChallengeStore['read']>>,
  ): Promise<void> {
    await this.#parts.ssoPolicy.assertAllowed(firstFactorOf(found), 'passkey');
  }

  /**
   * A break-glass passkey assertion must carry user verification; every other
   * second-factor passkey needs presence only. Enforcement is read when the
   * ceremony is minted and again when it is checked, so a ceremony minted
   * before enforcement came on is refused and the person asks again.
   */
  async #secondFactorPurpose(
    found: Awaited<ReturnType<TotpChallengeStore['read']>>,
  ): Promise<'second-factor' | 'break-glass'> {
    return firstFactorOf(found) !== 'sso' && (await this.#parts.ssoPolicy.enforced())
      ? 'break-glass'
      : 'second-factor';
  }

  /** Passkey sign-in is a local method: refused under SSO enforcement, before anything is spent. */
  async #assertPasskeySignInAllowed(): Promise<void> {
    if (await this.#parts.ssoPolicy.enforced()) throw new AuthFailure('sso-required');
  }

  /**
   * A discoverable assertion carries the user handle it was made for. When it
   * is present it must be this account's; an authenticator that omits it is
   * accepted, because the credential row already names the account.
   */
  async #handleMatches(userId: string, presented: string | undefined): Promise<boolean> {
    if (presented === undefined) return true;
    const held = Buffer.from(await this.#parts.passkeys.userHandle(userId));
    const given = Buffer.from(presented, 'base64url');
    return held.length === given.length && timingSafeEqual(held, given);
  }

  async #spendCeremonyOptions(userId: string): Promise<void> {
    if (!(await this.#parts.limiter.consume(PASSKEY_CEREMONY_OPTIONS_RULE, userId))) {
      throw new AuthFailure('rate-limited');
    }
  }

  /** Stages a fresh secret, for both ways into enrolment. */
  async #stageSecret(
    user: StaffUser,
    refusal: 'totp-already-enabled' | 'challenge-expired',
    tx?: Queryable,
  ): Promise<TotpEnrolment> {
    const secret = newTotpSecret();

    // An authenticator that is on is never replaced from here. Changing it is a
    // step-up the plan does not define, so it is refused: turn it off (with a
    // live code), then enrol again.
    if (
      !(await this.#parts.staff.stageTotpSecret(
        user.id,
        encryptSecret(secret, this.#parts.keyring),
        tx,
      ))
    ) {
      throw new AuthFailure(refusal);
    }

    return {
      secret,
      uri: totpUri({ secret, email: user.email, issuer: new URL(this.#parts.appUrl).host }),
    };
  }

  async #enableSecondFactor(
    user: StaffUser,
    tx?: DbTransaction,
    { notify = true }: { readonly notify?: boolean } = {},
  ): Promise<RecoveryCodes> {
    // One set of codes per account, drawn with its first second factor of either
    // kind. An app added beside a passkey keeps the set the passkey brought.
    const hasPasskey = (await this.#parts.passkeys.count(user.id, tx)) > 0;
    const recoveryCodes = hasPasskey ? [] : newRecoveryCodes();
    await this.#parts.staff.enableTotp(
      user.id,
      hasPasskey
        ? user.recoveryCodesHashed
        : await hashRecoveryCodes(recoveryCodes, this.#parts.hasher),
      tx,
    );
    await this.#parts.challenges.clearLock(user.id);
    await this.#afterCommit(() => this.#parts.rotations.clearForUser(user.id));
    this.#parts.logger.info({ userId: user.id }, 'Enabled the second factor for a staff account');
    await this.#audit('auth.second_factor.enabled', user.id, 'staff');
    if (notify) await this.#notifySecurityChange(user.id, 'twoFactorEnabled', tx);

    return { recoveryCodes };
  }

  /**
   * Whether `code` is this account's authenticator code, and one it has not
   * used before (ASVS 2.8.4, 2.8.5). A replayed code is refused exactly like a
   * wrong one — the person at the form learns nothing new — and is logged and
   * audited, because a valid code arriving twice means somebody else saw it.
   */
  async #checkCode(user: StaffUser, code: string, during: string): Promise<CodeCheck> {
    const secret = this.#totpSecretOf(user);
    const step = secret === null ? null : await matchTotpStep({ secret, code });

    if (step === null) {
      await this.#audit('auth.second_factor.failed', user.id, 'system', {
        factor: 'totp',
        during,
      });
      return 'mismatch';
    }

    if (!(await this.#parts.steps.claim(user.id, step))) {
      this.#parts.logger.warn(
        { userId: user.id, during },
        'An authenticator code was presented again after it had been accepted; refused',
      );
      await this.#audit('auth.second_factor.replayed', user.id, 'system', { during });
      return 'replayed';
    }

    return 'accepted';
  }

  async #assertSignInAllowed(email: string | undefined, ip: string): Promise<SignInAttempt> {
    const { attempt, retryAfter } = await this.#parts.limiter.reserveSignIn(ip, email);
    if (retryAfter > 0) throw new AuthFailure('rate-limited', { retryAfter });
    return attempt;
  }

  /**
   * Before a sign-in link is read or spent. SSO enforcement refuses outright,
   * and before the token is touched, so a link refused for it is not burnt:
   * break-glass access is a password and a fresh code or passkey, and a link is neither.
   */
  async #assertMagicLinkAllowed(ip: string): Promise<void> {
    if (!(await this.#parts.limiter.consume(MAGIC_LINK_LOOKUP_RULE, ip))) {
      this.#parts.logger.warn({ ip }, 'A sign-in link request was refused by the rate limit');
      throw new AuthFailure('unavailable');
    }
    if (await this.#parts.ssoPolicy.enforced()) throw new AuthFailure('sso-required');
  }

  /** The account a sign-in link opens, or `undefined` when it opens none. */
  async #magicLinkUser(payload: EmailTokenPayload | null): Promise<StaffUser | undefined> {
    if (payload === null) {
      return undefined;
    }

    const user = await this.#parts.staff.findById(payload.userId);
    return user !== undefined && this.#isUsable(user) ? user : undefined;
  }

  async #allowEmailDispatch(email: string, ip: string): Promise<boolean> {
    const withinEmailBudget = await this.#parts.limiter.consume(EMAIL_DISPATCH_RULE, email);
    const withinIpBudget = await this.#parts.limiter.consume(EMAIL_DISPATCH_IP_RULE, ip);

    return withinEmailBudget && withinIpBudget;
  }

  /**
   * An install with no system sender cannot put a sign-in link or a reset link
   * in anybody's inbox, and a screen that then said "check your email" would
   * leave a locked-out admin with nowhere to go (#369). The request is refused
   * with `email-unavailable` before any address is looked up — the answer is
   * about this install's configuration, it is the same for every address, and
   * it spends no budget, so it leaks nothing about accounts (DOMAIN-RULES §12).
   * The worker's warn log stays as the belt for an install whose sender is
   * removed between this check and the send.
   */
  async #assertSenderCanSend(): Promise<void> {
    const [host, fromAddress] = await Promise.all([
      this.#parts.settings.get('smtp.host'),
      this.#parts.settings.get('smtp.from'),
    ]);
    if (!systemSenderConfigured(host, fromAddress)) {
      throw new AuthFailure('email-unavailable');
    }
  }

  /**
   * A second-factor step spends the IP budget only, never the address one. The
   * address bucket guards the password: charging it here would let anyone who
   * knows a staff address lock that person out of an SSO, magic-link or OAuth
   * sign-in with junk passwords. Guesses at the code are bounded per
   * account, not per address: each wrong value also counts on the user's own
   * counter, across challenges, and three of them set the 15-minute lock
   * (TotpChallengeStore.reserveAttempt). Only someone holding a live challenge,
   * who has proved the first factor, can spend it. The returned attempt carries
   * the address solely so that a completed sign-in clears the address bucket;
   * the attempt was never added to it.
   */
  async #signInChallenge(challengeId: string, kind: 'second-factor' | 'enrolment', ip: string) {
    let resolved: { challenge: Awaited<ReturnType<TotpChallengeStore['read']>>; user: StaffUser };
    try {
      resolved = await this.#requireChallenge(challengeId, kind);
    } catch (error) {
      if (error instanceof AuthFailure) await this.#assertSignInAllowed(undefined, ip);
      throw error;
    }
    const reserved = await this.#assertSignInAllowed(undefined, ip);
    return { ...resolved, attempt: { ...reserved, email: resolved.user.email } };
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

    if (found.challenge.firstFactor === 'sso') {
      if (!found.challenge.ssoConnectionId) throw new AuthFailure('challenge-expired');
      await this.#parts.sso.assertLinked(user.id, found.challenge.ssoConnectionId);
    }
    if (found.challenge.firstFactor !== 'sso')
      await this.#parts.ssoPolicy.assertLocal(
        user.email,
        found.challenge.firstFactor ?? 'password',
      );
    return { challenge: found, user };
  }

  /**
   * Taken before any code is evaluated, whichever form it was typed into, so a
   * lock cannot be dodged by switching to the recovery code field and a
   * parallel burst cannot evaluate more guesses than the budget allows.
   * Returns the attempts left once this one is counted.
   */
  async #reserveAttempt(
    challengeId: string,
    found: Awaited<ReturnType<TotpChallengeStore['read']>>,
  ): Promise<number> {
    /* c8 ignore next 3 -- `#requireChallenge` only ever hands over an `ok`. */
    if (found.status !== 'ok') {
      throw new AuthFailure('challenge-expired');
    }

    const outcome = await this.#parts.challenges.reserveAttempt(challengeId, found.challenge);
    if (outcome.status === 'expired') throw new AuthFailure('challenge-expired');
    if (outcome.status === 'locked') {
      await this.#audit('auth.sign_in.failed', found.challenge.userId, 'system', {
        method: found.challenge.firstFactor ?? 'unknown',
        reason: 'locked',
      });
      throw new AuthFailure('totp-locked');
    }

    return outcome.attemptsLeft;
  }

  /** A reserved evaluation came back wrong; the last one locks the account. */
  async #failAttempt(
    challengeId: string,
    found: Awaited<ReturnType<TotpChallengeStore['read']>>,
    attemptsLeft: number,
    code: 'totp-mismatch' | 'recovery-invalid' | 'passkey-invalid',
  ): Promise<AuthFailure> {
    /* c8 ignore next 3 -- `#requireChallenge` only ever hands over an `ok`. */
    if (found.status !== 'ok') {
      return new AuthFailure('challenge-expired');
    }

    const outcome = await this.#parts.challenges.failAttempt(
      challengeId,
      found.challenge,
      attemptsLeft,
    );
    if (outcome.status === 'locked') {
      this.#parts.logger.warn(
        { userId: found.challenge.userId },
        'A second-factor challenge used its last attempt; the account is locked for 15 minutes',
      );
      await this.#audit('auth.account.locked', found.challenge.userId, 'system', {
        challenge: found.challenge.kind,
      });
      return new AuthFailure('totp-locked');
    }

    return new AuthFailure(code, { attemptsLeft: outcome.attemptsLeft });
  }

  /** Spends the challenge for a correct code, refusing if it was locked or taken meanwhile. */
  async #consumeChallenge(challengeId: string, userId: string): Promise<void> {
    const result = await this.#parts.challenges.consume(challengeId, userId);
    if (result === 'locked') throw new AuthFailure('totp-locked');
    if (result === 'expired') throw new AuthFailure('challenge-expired');
  }

  /**
   * The account behind a signed-in request, with a live authenticator code
   * proved. Shared by the two operations that weaken the second factor.
   */
  async #requireLiveCode(userId: string, code: string, tx?: Queryable): Promise<StaffUser> {
    await this.#spendStepUp(userId);

    const user = await this.#requireUser(userId, tx);

    // A wrong or replayed code is audited by `#checkCode`, with `during: step-up`.
    if (!user.totpEnabled || (await this.#checkCode(user, code, 'step-up')) !== 'accepted') {
      throw new AuthFailure('totp-mismatch');
    }

    return user;
  }

  /** The account behind a signed-in request, with its current password proved again. */
  async #requireCurrentPassword(
    userId: string,
    currentPassword: string,
    tx?: Queryable,
  ): Promise<StaffUser> {
    await this.#spendStepUp(userId);

    const user = await this.#requireUser(userId, tx);
    if (user.passwordHash === null) {
      // An account that signs in with OAuth or a link alone has no current
      // password to prove; it sets one through the reset flow, which proves
      // the address instead.
      throw new AuthFailure('invalid-credentials');
    }

    const verification = await this.#parts.hasher.verify(user.passwordHash, currentPassword);
    if (!verification.valid) {
      await this.#audit('auth.step_up.refused', user.id, 'system', { reason: 'wrong-password' });
      throw new AuthFailure('invalid-credentials');
    }

    return user;
  }

  // ------------------------------------------------------------------
  // What PasskeyService borrows
  //
  // A passkey change is one more credential change, so it spends the same
  // step-up budget, writes the same audit trail and sends the same notice
  // as a password or a provider account. These hand those over rather than
  // copying them.
  // ------------------------------------------------------------------

  /** The signed-in account, or `no-account` when it is gone or deactivated. */
  activeAccount(userId: string, tx?: Queryable): Promise<StaffUser> {
    return this.#requireUser(userId, tx);
  }

  /** The current password or a live code, one of them, from the shared step-up budget. */
  confirmWithSecret(userId: string, proof: OauthStepUpRequest, tx?: Queryable): Promise<StaffUser> {
    return this.#requireStepUp(userId, proof, tx);
  }

  /** One attempt from the same budget, for a proof that is not a secret to compare. */
  spendStepUpAttempt(userId: string): Promise<void> {
    return this.#spendStepUp(userId);
  }

  recordCredentialEvent(
    action: AuthAuditAction,
    userId: string,
    actor: 'staff' | 'system',
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.#audit(action, userId, actor, meta);
  }

  notifyCredentialChange(
    userId: string,
    change: SecurityChange,
    tx: DbTransaction | undefined,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    return this.#notifySecurityChange(userId, change, tx, values);
  }

  /** Whichever of the two a person offered: the current password, or a live code. */
  #requireStepUp(userId: string, proof: OauthStepUpRequest, tx?: Queryable): Promise<StaffUser> {
    return proof.code === undefined
      ? this.#requireCurrentPassword(userId, proof.currentPassword ?? '', tx)
      : this.#requireLiveCode(userId, proof.code, tx);
  }

  /**
   * Runs `fn` once the request's transaction has committed. Outside a request
   * (a job, a script) there is no transaction to wait for, so it runs at once.
   */
  async #afterCommit(fn: () => Promise<void>): Promise<void> {
    const context = currentRequestContext();
    if (context === undefined) {
      await fn();
      return;
    }
    runAfterCommit(fn);
  }

  /**
   * The budget for re-proving a credential from inside a session. Sign-in has a
   * spendable challenge for this; these routes have none, so without a limit
   * six digits is a few minutes of guessing away from turning somebody's second
   * factor off.
   */
  async #spendStepUp(userId: string): Promise<void> {
    if (!(await this.#parts.limiter.consume(STEP_UP_RULE, userId))) {
      this.#parts.logger.warn({ userId }, 'A step-up check was refused by the rate limit');
      await this.#audit('auth.step_up.refused', userId, 'system', { reason: 'rate-limited' });
      throw new AuthFailure('totp-locked');
    }
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

  /**
   * The link's token lives in Redis alone, so there is no transaction to join:
   * `queueForAccount` writes the outbox row in one of its own, after the token
   * exists (`auth-email.ts` says why that order).
   */
  async #send(request: AuthEmailRequest) {
    if (!(await this.#parts.mail.queueForAccount(request))) {
      this.#parts.logger.info(
        { userId: request.userId, kind: request.kind },
        'Auth email not queued: the account holds no role in an active brand',
      );
    }
  }

  /**
   * Tells the account holder a credential changed (ASVS 2.2.3, 2.5.5). From
   * inside a request the outbox row joins the request's transaction, so a
   * change that rolls back sends nothing; it is routed through the first brand
   * of the account that this transaction can see, which is a brand the person
   * works in. A reset has no transaction to join and goes the way the reset
   * link itself went.
   */
  #securityChangeRequest(
    userId: string,
    change: SecurityChange,
    values: Readonly<Record<string, string>> = {},
  ): AuthEmailRequest {
    return {
      kind: 'securityChange',
      userId,
      url: new URL('/me/security', this.#parts.appUrl).toString(),
      values: { ...values, change, occurredAt: new Date().toISOString() },
    };
  }

  async #notifySecurityChange(
    userId: string,
    change: SecurityChange,
    tx?: DbTransaction,
    values: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    const request = this.#securityChangeRequest(userId, change, values);

    const [brandId] =
      tx === undefined
        ? []
        : (await this.#parts.staff.membershipsOf(userId, tx))
            .map((membership) => membership.brandId)
            .sort();

    if (tx === undefined || brandId === undefined) {
      await this.#send(request);
      return;
    }

    await this.#parts.mail.queue(tx, brandId, request);
  }

  #audit(
    action: AuthAuditAction,
    userId: string | null,
    actor: 'staff' | 'system',
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.#parts.audit.record({
      action,
      userId,
      actor,
      ...(meta === undefined ? {} : { meta }),
    });
  }
}

/** The first factor a challenge was opened after; older challenges did not record one. */
const firstFactorOf = (found: Awaited<ReturnType<TotpChallengeStore['read']>>): string =>
  found.status === 'ok' ? (found.challenge.firstFactor ?? 'unknown') : 'unknown';
