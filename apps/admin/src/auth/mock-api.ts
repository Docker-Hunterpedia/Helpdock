import type {
  AuthMethods,
  InviteAcceptRequest,
  InviteProviderStartRequest,
  MagicLinkPreview,
  OauthIdentity,
  OauthIdentityList,
  OauthProvider,
  OauthStepUpRequest,
  Passkey,
  PasskeyAdded,
  PasskeyEnrolmentRequest,
  PasskeyFinishRequest,
  PasskeyList,
  PasskeyProof,
  PasskeyRegistrationOptions,
  PasskeySecondFactorAnswer,
  PasskeyStepUpOptions,
  PublicInvite,
  RecoveryCodes,
  Session,
  SessionBrand,
  SignInResult,
  TotpEnrolment,
} from '@helpdock/schemas';
import { isLastSignInMethod, MAX_PASSKEYS_PER_ACCOUNT } from '@helpdock/schemas';
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

/**
 * Set to JSON before the app loads, it seeds the fixture's passkeys (M18-02):
 * `{"count": 10}` starts with ten, `{"onlyFactor": true}` makes the account one
 * that must have a second factor and has no authenticator app, and
 * `{"state": "paused"}` or `"unavailable"` changes what the card may do, and
 * `{"enrol": true}` makes the account one that must have a second factor and
 * has none, so a password sign-in ends in the enrolment chooser, and
 * `{"noApp": true}` takes the authenticator app away: with a passkey the second
 * step offers the passkey alone, and with none the account signs in with a
 * password and its first passkey draws the recovery codes (M18-03).
 */
export const MOCK_PASSKEYS_STORAGE = 'helpdock.mock.passkeys';

export interface SeededPasskeys {
  readonly count?: number;
  readonly onlyFactor?: boolean;
  readonly state?: PasskeyList['state'];
  readonly enrol?: boolean;
  readonly noApp?: boolean;
}

const seededPasskeys = (): SeededPasskeys => {
  try {
    const raw = globalThis.localStorage?.getItem(MOCK_PASSKEYS_STORAGE);
    return raw === null || raw === undefined ? {} : (JSON.parse(raw) as SeededPasskeys);
  } catch {
    return {};
  }
};

/** Wrong step-ups the fixture allows before it locks, like the api's budget. */
const MOCK_STEP_UP_ATTEMPTS = 5;

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const randomChallenge = (): string => base64Url(crypto.getRandomValues(new Uint8Array(32)));

interface MockPasskey {
  readonly passkey: Passkey;
  /** The credential id a virtual authenticator made, so a later step-up can name it. */
  readonly credentialId: string | null;
}

/** Drawn with an account's first second factor of either kind. */
const MOCK_RECOVERY_CODES: string[] = Array.from(
  { length: 10 },
  (_unused, index) => `RC-AB${index}-${1000 + index * 7}`,
);

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
  #passkeys: MockPasskey[] = [];
  #passkeyState: PasskeyList['state'] = 'available';
  /** An account that must have a second factor, with no authenticator app. */
  #onlySecondFactor = false;
  /** The account has no second factor yet and must enrol one before it gets a session. */
  #enrolmentRequired = false;
  /** Whether an authenticator app is on; it is for everyone but the accounts seeded without one. */
  #appOn = true;
  #ceremonies = new Set<string>();
  #stepUpFailures = 0;

  constructor(staff?: MockStaffApi) {
    this.#staff = staff;
    this.seedPasskeys(seededPasskeys());
  }

  /** Sets the account's passkeys up as a test or a stored seed asks (see {@link MOCK_PASSKEYS_STORAGE}). */
  seedPasskeys(seed: SeededPasskeys): void {
    this.#passkeyState = seed.state ?? 'available';
    this.#onlySecondFactor = seed.onlyFactor === true;
    this.#enrolmentRequired = seed.enrol === true;
    this.#appOn = seed.noApp !== true;
    this.#passkeys = Array.from({ length: seed.count ?? 0 }, (_unused, index) =>
      this.#mockPasskey(index === 0 ? 'MacBook Air · Touch ID' : `YubiKey ${index}`, null),
    );
  }

  /** Every method is on: the fixture exists to exercise every screen. */
  async authMethods(): Promise<AuthMethods> {
    return {
      sso: this.ssoConnections.map(({ id, name }) => ({ id, name })),
      ssoEnforced: this.ssoEnforced,
      password: true,
      magicLink: true,
      oauth: { google: true, microsoft: true, github: true },
      passkey: !this.ssoEnforced && this.#passkeyState === 'available',
      passkeysPaused: !this.ssoEnforced && this.#passkeyState === 'paused',
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

    const noFactor = !this.#appOn && this.#passkeys.length === 0;
    if (noFactor && !this.#enrolmentRequired) {
      return { kind: 'session', session: this.#signIn() };
    }

    if (this.#enrolmentRequired) {
      this.#challengeCounter += 1;
      return {
        kind: 'second-factor-enrolment-required',
        challengeId: `mock-enrol-${this.#challengeCounter}`,
      };
    }

    this.#challengeCounter += 1;
    const challengeId = `mock-challenge-${this.#challengeCounter}`;
    this.#challenges.set(challengeId, {
      email: MOCK_EMAIL,
      attemptsLeft: MOCK_TOTP_ATTEMPTS,
      locked: false,
    });

    return {
      kind: 'totp-required',
      challengeId,
      email: MOCK_EMAIL,
      factors: {
        totp: this.#appOn,
        passkey: this.#passkeys.length > 0 && this.#passkeyState === 'available',
      },
    };
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

  async passkeySecondFactorOptions(challengeId: string): Promise<PasskeyStepUpOptions> {
    this.#requireChallenge(challengeId);
    return this.passkeyStepUpOptions();
  }

  /**
   * Accepts the assertion of a credential the fixture knows, for a ceremony it
   * issued. A cancelled browser prompt never reaches here, so the counter is
   * only ever spent by an answer that arrived, as the api's is.
   */
  async verifyPasskey(
    challengeId: string,
    answer: PasskeySecondFactorAnswer,
    { trustDevice }: { readonly trustDevice: boolean },
  ): Promise<Session> {
    const challenge = this.#requireChallenge(challengeId);
    // A seeded passkey records no credential id: it stands for whatever the
    // browser's authenticator holds, so any answer to an issued ceremony counts.
    const known = this.#passkeys.some(
      (entry) => entry.credentialId === null || entry.credentialId === answer.response.rawId,
    );

    if (!this.#ceremonies.delete(answer.ceremonyId) || !known) {
      throw this.#spendAttempt(challenge, 'passkey-invalid');
    }

    this.#challenges.delete(challengeId);
    this.#trustedDevice = trustDevice;
    return this.#signIn();
  }

  /** Names no account, so it answers before anyone is known, like the api's. */
  async passkeySignInOptions(): Promise<PasskeyStepUpOptions> {
    this.#requirePasskeySignIn();
    const ceremonyId = randomChallenge();
    this.#ceremonies.add(ceremonyId);
    return {
      ceremonyId,
      options: {
        rpId: globalThis.location?.hostname ?? 'localhost',
        challenge: randomChallenge(),
        timeout: 300_000,
        userVerification: 'required',
      },
    };
  }

  /**
   * Signs in with a passkey the fixture holds, for a ceremony it issued; one
   * answer for an unknown credential, a spent ceremony and a missing account,
   * as the api gives. A seeded passkey records no credential id and stands
   * for whatever the browser's authenticator holds.
   */
  async signInWithPasskey(answer: PasskeySecondFactorAnswer): Promise<Session> {
    this.#requirePasskeySignIn();
    const known = this.#passkeys.some(
      (entry) => entry.credentialId === null || entry.credentialId === answer.response.rawId,
    );
    if (!this.#ceremonies.delete(answer.ceremonyId) || !known) {
      throw new AuthError('invalid-credentials');
    }

    return this.#signIn();
  }

  #requirePasskeySignIn(): void {
    if (this.ssoEnforced) {
      throw new AuthError('sso-required');
    }
    if (this.#passkeyState !== 'available') {
      throw new AuthError(
        this.#passkeyState === 'paused' ? 'passkeys-rp-changed' : 'passkeys-unavailable',
      );
    }
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

  async passkeys(): Promise<PasskeyList> {
    return {
      passkeys: this.#passkeys.map((entry) => entry.passkey),
      limit: MAX_PASSKEYS_PER_ACCOUNT,
      state: this.#passkeyState,
      removalBlocked: this.#onlySecondFactor && this.#passkeys.length === 1,
      authenticatorApp: this.#appOn && !this.#onlySecondFactor,
    };
  }

  async passkeyStepUpOptions(): Promise<PasskeyStepUpOptions> {
    if (this.#passkeys.length === 0) {
      throw new AuthError('invalid-credentials');
    }
    const ceremonyId = randomChallenge();
    this.#ceremonies.add(ceremonyId);
    return {
      ceremonyId,
      options: {
        rpId: globalThis.location?.hostname ?? 'localhost',
        challenge: randomChallenge(),
        timeout: 300_000,
        userVerification: 'preferred',
        allowCredentials: this.#passkeys
          .flatMap((entry) => (entry.credentialId === null ? [] : [entry.credentialId]))
          .map((id) => ({ id, type: 'public-key' })),
      },
    };
  }

  async beginPasskey(proof: PasskeyProof): Promise<PasskeyRegistrationOptions> {
    if (this.#passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
      throw new AuthError('passkey-limit');
    }
    this.#assertPasskeyProof(proof);
    return this.#registrationOptions();
  }

  #registrationOptions(): PasskeyRegistrationOptions {
    const ceremonyId = randomChallenge();
    this.#ceremonies.add(ceremonyId);
    return {
      ceremonyId,
      options: {
        rp: { id: globalThis.location?.hostname ?? 'localhost', name: 'Helpdock' },
        user: {
          id: randomChallenge(),
          name: MOCK_EMAIL,
          displayName: MOCK_USER.name,
        },
        challenge: randomChallenge(),
        pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key', alg })),
        timeout: 300_000,
        attestation: 'none',
        excludeCredentials: this.#passkeys
          .flatMap((entry) => (entry.credentialId === null ? [] : [entry.credentialId]))
          .map((id) => ({ id, type: 'public-key' })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        extensions: { credProps: true },
      },
    };
  }

  async finishPasskey(request: PasskeyFinishRequest): Promise<PasskeyAdded> {
    if (!this.#ceremonies.delete(request.ceremonyId)) {
      throw new AuthError('challenge-expired');
    }
    if (this.#passkeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
      throw new AuthError('passkey-limit');
    }
    // Recovery codes come with the account's first second factor of either kind.
    const first = (!this.#appOn || this.#onlySecondFactor) && this.#passkeys.length === 0;
    const entry = this.#mockPasskey(request.name, request.response.rawId);
    this.#passkeys.push(entry);
    return first ? { ...entry.passkey, recoveryCodes: MOCK_RECOVERY_CODES } : entry.passkey;
  }

  async renamePasskey(id: string, name: string, proof: PasskeyProof): Promise<Passkey> {
    const index = this.#passkeys.findIndex((entry) => entry.passkey.id === id);
    const entry = this.#passkeys[index];
    if (entry === undefined) {
      throw new AuthError('no-account');
    }
    this.#assertPasskeyProof(proof);
    const renamed = { ...entry, passkey: { ...entry.passkey, name } };
    this.#passkeys[index] = renamed;
    return renamed.passkey;
  }

  async removePasskey(id: string, proof: PasskeyProof): Promise<void> {
    if (!this.#passkeys.some((entry) => entry.passkey.id === id)) {
      throw new AuthError('no-account');
    }
    if (this.#onlySecondFactor && this.#passkeys.length === 1) {
      throw new AuthError('second-factor-required');
    }
    this.#assertPasskeyProof(proof);
    this.#passkeys = this.#passkeys.filter((entry) => entry.passkey.id !== id);
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
    this.#enrolmentRequired = false;
    const session = this.#signIn();

    return { recoveryCodes, session };
  }

  async startPasskeyEnrolment(challengeId: string): Promise<PasskeyRegistrationOptions> {
    if (!challengeId.startsWith('mock-enrol-')) {
      throw new AuthError('challenge-expired');
    }
    if (this.#passkeyState !== 'available') {
      throw new AuthError(
        this.#passkeyState === 'paused' ? 'passkeys-rp-changed' : 'passkeys-unavailable',
      );
    }
    return this.#registrationOptions();
  }

  async completePasskeyEnrolment(
    challengeId: string,
    request: PasskeyEnrolmentRequest,
  ): Promise<RecoveryCodes & { readonly session: Session }> {
    if (!challengeId.startsWith('mock-enrol-')) {
      throw new AuthError('challenge-expired');
    }
    if (!this.#ceremonies.delete(request.ceremonyId)) {
      throw new AuthError('passkey-invalid', { attemptsLeft: MOCK_TOTP_ATTEMPTS - 1 });
    }
    this.#passkeys.push(this.#mockPasskey(request.name, request.response.rawId));
    this.#enrolmentRequired = false;

    return { recoveryCodes: MOCK_RECOVERY_CODES, session: this.#signIn() };
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

    return {
      kind: 'second-factor-enrolment-required',
      challengeId: `mock-enrol-${this.#challengeCounter}`,
    };
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
  #spendAttempt(
    challenge: Challenge,
    code: 'totp-mismatch' | 'recovery-invalid' | 'passkey-invalid',
  ): AuthError {
    challenge.attemptsLeft -= 1;

    if (challenge.attemptsLeft <= 0) {
      challenge.locked = true;
      return new AuthError('totp-locked');
    }

    return new AuthError(code, { attemptsLeft: challenge.attemptsLeft });
  }

  #mockPasskey(name: string, credentialId: string | null): MockPasskey {
    return {
      credentialId,
      passkey: {
        id: crypto.randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        synced: name.startsWith('MacBook'),
      },
    };
  }

  /**
   * The api's step-up for a passkey change: the password, a live code, or an
   * assertion for a ceremony the fixture issued. Five wrong tries lock it, as
   * the api's shared budget does.
   */
  #assertPasskeyProof(proof: PasskeyProof): void {
    if (this.#stepUpFailures >= MOCK_STEP_UP_ATTEMPTS) {
      throw new AuthError('totp-locked');
    }
    try {
      if (proof.passkey === undefined) {
        this.#assertStepUp(proof);
      } else if (!this.#ceremonies.delete(proof.passkey.ceremonyId)) {
        throw new AuthError('challenge-expired');
      }
    } catch (failure) {
      this.#stepUpFailures += 1;
      throw failure;
    }
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
