import { type AuthApi, AuthError } from './api.js';
import type { Brand, OauthProvider, Session, SignInResult } from './schemas.js';

/**
 * The fixture the admin app runs against until M0-05 (#8) ships real auth. It
 * is deliberately the whole of `AuthApi`, including the failure paths, so the
 * screens and the browser tests exercise the same states the real service will
 * produce.
 */

export const MOCK_EMAIL = 'lina@helpdock.com';
export const MOCK_PASSWORD = 'correct horse';
export const MOCK_TOTP_CODE = '482913';
export const MOCK_RECOVERY_CODE = 'RC-1234-5678';

/** DOMAIN-RULES §1.4: three tries, then a 15-minute lock. */
export const MOCK_TOTP_ATTEMPTS = 3;

/** Long enough that the "check your email" screen is a real transition. */
const MAGIC_LINK_DELAY_MS = 300;

export const MOCK_BRANDS: readonly Brand[] = [
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

const MOCK_SESSION: Session = {
  user: MOCK_USER,
  brands: [...MOCK_BRANDS],
  currentBrandId: MOCK_BRANDS[0]?.id ?? '',
  navCounts: { tickets: 24, contacts: 812, helpCenter: 36, reports: 9 },
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Challenge {
  readonly email: string;
  attemptsLeft: number;
  locked: boolean;
}

export class MockAuthApi implements AuthApi {
  readonly #challenges = new Map<string, Challenge>();
  #session: Session | null = null;
  #challengeCounter = 0;
  #recoveryCodeUsed = false;
  /** What a real install would store as a trusted-device cookie. */
  #trustedDevice = false;

  async signInWithPassword(email: string, password: string): Promise<SignInResult> {
    if (email.trim().toLowerCase() !== MOCK_EMAIL || password !== MOCK_PASSWORD) {
      throw new AuthError('invalid-credentials');
    }

    // A browser the user chose to trust skips the second factor, which is what
    // "Trust this browser for 30 days" buys them.
    if (this.#trustedDevice) {
      this.#session = MOCK_SESSION;
      return { kind: 'session', session: MOCK_SESSION };
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

  /**
   * The address is not read: answering the same way for an unknown one is what
   * stops the form telling a stranger which addresses exist (REQUIREMENTS §5.1).
   */
  async requestMagicLink(_email: string): Promise<void> {
    await delay(MAGIC_LINK_DELAY_MS);
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
    this.#session = MOCK_SESSION;

    return MOCK_SESSION;
  }

  async useRecoveryCode(challengeId: string, code: string): Promise<Session> {
    const challenge = this.#requireChallenge(challengeId);

    if (this.#recoveryCodeUsed || code.trim().toUpperCase() !== MOCK_RECOVERY_CODE) {
      throw this.#spendAttempt(challenge, 'recovery-invalid');
    }

    this.#recoveryCodeUsed = true;
    this.#challenges.delete(challengeId);
    this.#session = MOCK_SESSION;

    return MOCK_SESSION;
  }

  oauthStartUrl(provider: OauthProvider): string {
    // Lands on the app's own callback route: there is no provider to talk to
    // until M0-05 registers the OAuth clients.
    return `/oauth/callback?provider=${provider}`;
  }

  async me(): Promise<Session | null> {
    return this.#session;
  }

  async signOut(): Promise<void> {
    this.#session = null;
    this.#challenges.clear();
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
}
