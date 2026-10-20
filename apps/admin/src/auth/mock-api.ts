import type {
  AuthMethods,
  InviteAcceptRequest,
  InviteProviderStartRequest,
  MagicLinkPreview,
  OauthIdentity,
  OauthIdentityList,
  OauthProvider,
  OauthStepUpRequest,
  PublicInvite,
  RecoveryCodes,
  Session,
  SessionBrand,
  SignInResult,
  TotpEnrolment,
} from '@helpdock/schemas';
import { isLastSignInMethod } from '@helpdock/schemas';
import {
  assertNotMockBreached,
  MOCK_ENROLMENT_CODE,
  MOCK_TOTP_SECRET,
  type MockStaffApi,
} from '../staff/mock-api.js';
import { type AuthApi, AuthError } from './api.js';

/**
 * The fixture the admin app runs against until M0-05 (#8) ships real auth. It
 * is deliberately the whole of `AuthApi`, including the failure paths, so the
 * screens and the browser tests exercise the same states the real service will
 * produce.
 */

export const MOCK_EMAIL = 'lina@helpdock.com';
/** The GitHub account the fixture answers an invitation with: not the invited address. */
export const MOCK_INVITE_MISMATCH_ACCOUNT = 'nour.s@users.noreply.github.com';
export const MOCK_PASSWORD = 'correct horse';
export const MOCK_TOTP_CODE = '482913';
export const MOCK_RECOVERY_CODE = 'RC-1234-5678';
/** Not a JWT and not meant to be: nothing in the fixture verifies it. */
export const MOCK_ACCESS_TOKEN = 'mock-access-token';

/** The one sign-in link the fixture knows; any other token is expired or spent. */
export const MOCK_MAGIC_LINK_TOKEN = 'mock-magic-link';
export const MOCK_MAGIC_LINK_MINUTES = 10;

/** DOMAIN-RULES §1.4: three tries, then a 15-minute lock. */
export const MOCK_TOTP_ATTEMPTS = 3;

/** Long enough that the "check your email" screen is a real transition. */
const MAGIC_LINK_DELAY_MS = 300;

export const MOCK_BRANDS: readonly SessionBrand[] = [
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
    name: 'Helpdock',
    domain: 'support.helpdock.com',
    ticketPrefix: 'HD',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000002',
    name: 'Helpdock EU',
    domain: 'support.eu.helpdock.com',
    ticketPrefix: 'HDE',
  },
  {
    id: '0192c3f0-1a2b-7c3d-8e4f-000000000003',
    name: 'Helpdock Labs',
    domain: 'labs.helpdock.com',
    ticketPrefix: 'HDL',
  },
];

export const MOCK_USER: Session['user'] = {
  id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
  name: 'Lina Haddad',
  email: MOCK_EMAIL,
  role: 'admin',
  installAdmin: true,
};

/**
 * Set to `off` before the app loads, it makes the fixture's account start with
 * single-key shortcuts off (M14-01), which is how a browser test proves the
 * switch is read from the account rather than from the browser.
 */
export const MOCK_SINGLE_KEY_STORAGE = 'helpdock.mock.singleKeyShortcuts';

const seededSingleKeyShortcuts = (): false | undefined => {
  try {
    return globalThis.localStorage?.getItem(MOCK_SINGLE_KEY_STORAGE) === 'off' ? false : undefined;
  } catch {
    return undefined;
  }
};

const MOCK_SESSION: Session = {
  user: MOCK_USER,
  brands: [...MOCK_BRANDS],
  currentBrandId: MOCK_BRANDS[0]?.id ?? '',
  // No `navCounts`: the api sends none in 1.0, so neither does the fixture,
  // and the screenshots show the sidebar production shows.
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Challenge {
  readonly email: string;
  attemptsLeft: number;
  locked: boolean;
}

export class MockAuthApi implements AuthApi {
  readonly #challenges = new Map<string, Challenge>();
  /**
   * The same fixture the staff screens read, so an invitation sent on one
   * screen is the invitation the accept screen finds (M0-06).
   */
  readonly #staff: MockStaffApi | undefined;
  #session: Session | null = null;
  /**
   * M14-01: the account's single-key switch, absent (on) unless a test seeds
   * it off under `MOCK_SINGLE_KEY_STORAGE` or the sheet saves it.
   */
  #singleKeyShortcuts: boolean | undefined = seededSingleKeyShortcuts();
  #challengeCounter = 0;
  ssoEnforced = false;
  ssoConnections: { id: string; name: string; emailDomains: string[] }[] = [];
  #recoveryCodeUsed = false;
  #magicLinkSpent = false;
  /** What a real install would store as a trusted-device cookie. */
  #trustedDevice = false;
  /** Nothing linked, as on an install just upgraded to 1.0.1. */
  #identities: OauthIdentity[] = [];
  /** Off for the account whose only way in is a provider. */
  passwordSet = true;

  constructor(staff?: MockStaffApi) {
    this.#staff = staff;
  }

  /** Every method is on: the fixture exists to exercise every screen. */
  async authMethods(): Promise<AuthMethods> {
    return {
      sso: this.ssoConnections.map(({ id, name }) => ({ id, name })),
      ssoEnforced: this.ssoEnforced,
      password: true,
      magicLink: true,
      oauth: { google: true, github: true },
      passkey: false,
      passkeysPaused: false,
    };
  }

  async discoverSso(email: string) {
    const domain = email.split('@')[1]?.toLowerCase();
    return {
      connections: this.ssoConnections
        .filter((connection) => connection.emailDomains.includes(domain ?? ''))
        .map(({ id, name }) => ({ id, name })),
    };
  }

  ssoStartUrl(_connectionId: string, returnTo: string): string {
    return `/sign-in/complete?${new URLSearchParams({ code: 'mock-sso', returnTo })}`;
  }

  async signInWithPassword(email: string, password: string): Promise<SignInResult> {
    if (email.trim().toLowerCase() !== MOCK_EMAIL || password !== MOCK_PASSWORD) {
      throw new AuthError('invalid-credentials');
    }

    return this.#afterFirstFactor();
  }

  /**
   * The address is not read: answering the same way for an unknown one is what
   * stops the form telling a stranger which addresses exist (REQUIREMENTS §5.1).
   */
  async requestMagicLink(_email: string): Promise<void> {
    await delay(MAGIC_LINK_DELAY_MS);
  }

  async previewMagicLink(token: string): Promise<MagicLinkPreview> {
    this.#requireMagicLink(token);
    return { email: MOCK_EMAIL, expiresInMinutes: MOCK_MAGIC_LINK_MINUTES };
  }

  /** Spends the fixture's one link, then asks for the second factor as a password would. */
  async consumeMagicLink(token: string): Promise<SignInResult> {
    this.#requireMagicLink(token);
    this.#magicLinkSpent = true;
    return this.#afterFirstFactor();
  }

  #requireMagicLink(token: string): void {
    if (this.ssoEnforced) {
      throw new AuthError('sso-required');
    }
    if (token !== MOCK_MAGIC_LINK_TOKEN || this.#magicLinkSpent) {
      throw new AuthError('challenge-expired');
    }
  }

  #afterFirstFactor(): SignInResult {
    // A browser the user chose to trust skips the second factor, which is what
    // "Trust this browser for 30 days" buys them.
    if (this.#trustedDevice) {
      const session = this.#signIn();
      return { kind: 'session', session };
    }

    this.#challengeCounter += 1;
    const challengeId = `mock-challenge-${this.#challengeCounter}`;
    this.#challenges.set(challengeId, {
      email: MOCK_EMAIL,
      attemptsLeft: MOCK_TOTP_ATTEMPTS,
      locked: false,
    });

    return { kind: 'totp-required', challengeId, email: MOCK_EMAIL };
  }

  async verifyTotp(
    challengeId: string,
    code: string,
    { trustDevice }: { readonly trustDevice: boolean },
  ): Promise<Session> {
    const challenge = this.#requireChallenge(challengeId);

    if (code !== MOCK_TOTP_CODE) {
      throw this.#spendAttempt(challenge, 'totp-mismatch');
    }

    this.#challenges.delete(challengeId);
    this.#trustedDevice = trustDevice;
    return this.#signIn();
  }

  async useRecoveryCode(challengeId: string, code: string): Promise<Session> {
    const challenge = this.#requireChallenge(challengeId);

    if (this.#recoveryCodeUsed || code.trim().toUpperCase() !== MOCK_RECOVERY_CODE) {
      throw this.#spendAttempt(challenge, 'recovery-invalid');
    }

    this.#recoveryCodeUsed = true;
    this.#challenges.delete(challengeId);
    return this.#signIn();
  }

  oauthStartUrl(provider: OauthProvider): string {
    // Lands on the app's own callback route: there is no provider to talk to
    // until M0-05 registers the OAuth clients.
    return `/oauth/callback?provider=${provider}`;
  }

  async oauthIdentities(): Promise<OauthIdentityList> {
    return { identities: [...this.#identities], passwordSet: this.passwordSet };
  }

  /**
   * Links at once and answers the page the real callback redirects to, since
   * there is no provider for the browser to visit in between.
   */
  async connectOauth(provider: OauthProvider, proof: OauthStepUpRequest): Promise<string> {
    this.#assertStepUp(proof);
    if (this.#identities.some((identity) => identity.provider === provider)) {
      throw new AuthError('oauth-identity-conflict');
    }
    this.#identities.push({
      provider,
      email: MOCK_EMAIL,
      connectedAt: new Date().toISOString(),
      lastUsedAt: null,
    });

    return `/me/security?connected=${provider}`;
  }

  async disconnectOauth(provider: OauthProvider, proof: OauthStepUpRequest): Promise<void> {
    if (isLastSignInMethod(await this.oauthIdentities(), provider)) {
      throw new AuthError('oauth-last-sign-in');
    }
    this.#assertStepUp(proof);
    this.#identities = this.#identities.filter((identity) => identity.provider !== provider);
  }

  /**
   * What the real adapter does with the one-time code a redirect carried. The
   * fixture has no redirect to have carried one, so any code signs in: the
   * screen under test is the one that reads the parameter, not the exchange.
   */
  async exchange(_code: string): Promise<Session> {
    return this.#signIn();
  }

  /** The same answer for any address, for the same reason as the magic link. */
  async requestPasswordReset(_email: string): Promise<void> {
    await delay(MAGIC_LINK_DELAY_MS);
  }

  async resetPassword(_token: string, password: string): Promise<void> {
    await delay(MAGIC_LINK_DELAY_MS);
    assertNotMockBreached(password);
  }

  /**
   * A fixed secret, so the QR the enrolment screen draws is the same every run
   * and a browser test can assert on it without decoding an image.
   */
  async enrolTotp(): Promise<TotpEnrolment> {
    return {
      secret: MOCK_TOTP_SECRET,
      uri: `otpauth://totp/Helpdock:${encodeURIComponent(MOCK_EMAIL)}?secret=${MOCK_TOTP_SECRET}&issuer=Helpdock`,
    };
  }

  async confirmTotp(code: string): Promise<RecoveryCodes> {
    if (code !== MOCK_ENROLMENT_CODE) {
      throw new AuthError('totp-mismatch');
    }

    return (
      this.#staff?.markTotpEnabled() ?? {
        recoveryCodes: Array.from(
          { length: 10 },
          (_unused, index) => `RC-AB${index}-${1000 + index * 7}`,
        ),
      }
    );
  }

  async startEnrolment(challengeId: string): Promise<TotpEnrolment> {
    if (!challengeId.startsWith('mock-enrol-')) {
      throw new AuthError('challenge-expired');
    }
    return this.enrolTotp();
  }

  async completeEnrolment(
    challengeId: string,
    code: string,
  ): Promise<RecoveryCodes & { readonly session: Session }> {
    await this.startEnrolment(challengeId);
    const { recoveryCodes } = await this.confirmTotp(code);
    const session = this.#signIn();

    return { recoveryCodes, session };
  }

  async previewInvite(token: string): Promise<PublicInvite> {
    const invite = this.#staff?.inviteFor(token);
    if (invite === undefined) {
      throw new AuthError('challenge-expired');
    }

    return invite;
  }

  async acceptInvite(token: string, request: InviteAcceptRequest): Promise<SignInResult> {
    const invite = this.#staff?.inviteFor(token);
    if (invite === undefined) {
      throw new AuthError('challenge-expired');
    }
    assertNotMockBreached(request.password);

    this.#staff?.spendInvite(token);
    // An install that requires 2FA sends a brand new account to enrolment
    // before it ever sees a screen; the fixture always does, because that is
    // the path the enrolment screen exists for.
    this.#challengeCounter += 1;

    return { kind: 'totp-enrolment-required', challengeId: `mock-enrol-${this.#challengeCounter}` };
  }

  /**
   * Answers the page the real callback would redirect to. Google's account is
   * the invited address's, so it accepts and goes on to enrolment as a
   * password would; GitHub's is another address, which is the mismatch state.
   */
  async startInviteOauth(
    token: string,
    provider: OauthProvider,
    _request: InviteProviderStartRequest,
  ): Promise<string> {
    if (this.#staff?.inviteFor(token) === undefined) {
      throw new AuthError('challenge-expired');
    }
    if (provider === 'github') {
      return `/oauth/callback?error=oauth-invite-mismatch&provider=github#account=${encodeURIComponent(MOCK_INVITE_MISMATCH_ACCOUNT)}`;
    }

    this.#staff?.spendInvite(token);
    this.#challengeCounter += 1;
    return `/oauth/callback?enrol=mock-enrol-${this.#challengeCounter}&provider=${provider}`;
  }

  async me(): Promise<Session | null> {
    return this.#session;
  }

  /** M14-01: what `PUT /api/me/keyboard` does to the account, as the session shows it. */
  saveSingleKeyShortcuts(on: boolean): void {
    this.#singleKeyShortcuts = on;
    if (this.#session !== null) {
      this.#session = this.#withSwitch(this.#session);
    }
  }

  #signIn(): Session {
    const session = this.#withSwitch(MOCK_SESSION);
    this.#session = session;
    return session;
  }

  #withSwitch(session: Session): Session {
    return this.#singleKeyShortcuts === undefined
      ? session
      : { ...session, user: { ...session.user, singleKeyShortcuts: this.#singleKeyShortcuts } };
  }

  /** A value shaped like a token, so a caller can tell "signed in" from "not". */
  async accessToken(): Promise<string | null> {
    return this.#session === null ? null : MOCK_ACCESS_TOKEN;
  }

  async signOut(): Promise<void> {
    this.#session = null;
    this.#challenges.clear();
  }

  async signOutEverywhere(): Promise<void> {
    this.#trustedDevice = false;
    await this.signOut();
  }

  #requireChallenge(challengeId: string): Challenge {
    const challenge = this.#challenges.get(challengeId);
    if (!challenge) {
      throw new AuthError('challenge-expired');
    }
    if (challenge.locked) {
      throw new AuthError('totp-locked');
    }

    return challenge;
  }

  /**
   * A wrong code costs one try whichever field it was typed into, so a lock
   * cannot be dodged by switching to the recovery form.
   */
  #spendAttempt(challenge: Challenge, code: 'totp-mismatch' | 'recovery-invalid'): AuthError {
    challenge.attemptsLeft -= 1;

    if (challenge.attemptsLeft <= 0) {
      challenge.locked = true;
      return new AuthError('totp-locked');
    }

    return new AuthError(code, { attemptsLeft: challenge.attemptsLeft });
  }

  /** The api's step-up: the current password, or a live authenticator code. */
  #assertStepUp(proof: OauthStepUpRequest): void {
    if (proof.code !== undefined) {
      if (proof.code !== MOCK_TOTP_CODE) {
        throw new AuthError('totp-mismatch');
      }
      return;
    }
    if (!this.passwordSet || proof.currentPassword !== MOCK_PASSWORD) {
      throw new AuthError('invalid-credentials');
    }
  }
}
