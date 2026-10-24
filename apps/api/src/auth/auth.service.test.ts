import { randomBytes } from 'node:crypto';
import {
  createKeyring,
  createSettings,
  decryptSecret,
  encryptSecret,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import type { Brand, Db, DbTransaction, WebauthnCredential } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import argon2 from 'argon2';
import { generateKeyPair } from 'jose';
import { generate } from 'otplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SsoIdentityService } from '../sso/identity.service.js';
import { SsoSignInPolicy } from '../sso/sign-in-policy.js';
import { authRedis } from '../testing/auth-redis.js';
import { MemoryRpIdPin } from '../testing/memory-rp-id-pin.js';
import type { RedisStub } from '../testing/redis-stub.js';
import { silentLogger } from '../testing/silent-logger.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { AuthService, type OauthInviteAcceptor } from './auth.service.js';
import type { AuthAuditEntry, AuthAuditTrail } from './auth-audit.js';
import type { AuthEmailRequest, AuthMail } from './auth-email.js';
import type { AuthFailure } from './auth-failure.js';
import { AuthFailure as AuthFailureClass } from './auth-failure.js';
import { EmailTokenStore } from './email-token.store.js';
import { ExchangeStore } from './exchange.store.js';
import type {
  OauthCompletion,
  OauthIdentity,
  OauthInviteState,
  OauthService,
} from './oauth/oauth.service.js';
import { OauthError } from './oauth/oauth.service.js';
import type { OauthIdentityRepository, OauthLink } from './oauth/oauth-identity.repository.js';
import type { PasskeyRepository } from './passkeys/passkey.repository.js';
import { PasskeyService } from './passkeys/passkey.service.js';
import { derivePepper, PasswordHasher } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { totpLockKey } from './redis-keys.js';
import { RefreshStore } from './session/refresh-store.js';
import { SessionService } from './session/session.service.js';
import type { SigningKeys } from './session/signing-keys.js';
import type { StaffMembership, StaffRepository, StaffUser } from './staff.repository.js';
import { TotpChallengeStore } from './totp/challenge-store.js';
import { hashRecoveryCodes } from './totp/recovery-codes.js';
import { TotpRotationStore } from './totp/rotation-store.js';
import { newTotpSecret } from './totp/totp.js';
import { TrustedDeviceStore } from './totp/trusted-device.js';
import { TotpStepStore } from './totp/used-steps.js';
import { WebAuthnCeremonyStore } from './webauthn/ceremony-store.js';
import { WebAuthnService } from './webauthn/webauthn.service.js';

/**
 * The service on its own, with the database replaced by a handful of rows and
 * Redis by the in-memory stub. Everything that decides — which failure code,
 * which branch after a first factor, what a link is worth — is here; that the
 * decisions reach Postgres and a browser correctly is the integration suite's
 * job and the Playwright project's.
 */

const APP_URL = 'https://support.example.com';
const MASTER_KEY = randomBytes(32);
const MASTER_KEY_B64 = MASTER_KEY.toString('base64');
const PASSWORD = 'correct horse battery';

const BRAND_ID = uuidv7();

const brand = (id = BRAND_ID): Brand => ({
  id,
  name: 'Helpdock',
  prefix: 'HD',
  defaultLocale: 'en',
  timezone: 'UTC',
  status: 'active',
  settings: {},
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** Just enough of the repository to answer the service, all in memory. */
class FakeStaffRepository {
  async withSessionAuthority<T>(
    _userId: string,
    read: (tx?: DbTransaction) => Promise<T>,
  ): Promise<T> {
    return read();
  }

  readonly users = new Map<string, StaffUser>();
  readonly memberships = new Map<string, StaffMembership[]>();
  readonly brands: Brand[] = [brand()];

  add(user: StaffUser, role: StaffMembership['role'] = 'agent', brandId = BRAND_ID): StaffUser {
    this.users.set(user.id, user);
    this.memberships.set(user.id, [
      {
        id: uuidv7(),
        userId: user.id,
        brandId,
        role,
        source: 'manual',
        ssoConnectionId: null,
        departmentIds: null,
        createdAt: new Date(),
      },
    ]);

    return user;
  }

  findByEmail(email: string): Promise<StaffUser | undefined> {
    return Promise.resolve(
      [...this.users.values()].find(
        (user) => user.email.toLowerCase() === email.trim().toLowerCase(),
      ),
    );
  }

  findById(userId: string): Promise<StaffUser | undefined> {
    return Promise.resolve(this.users.get(userId));
  }

  membershipsOf(userId: string): Promise<StaffMembership[]> {
    return Promise.resolve(this.memberships.get(userId) ?? []);
  }

  activeBrandIds(): Promise<string[]> {
    return Promise.resolve(this.brands.map((found) => found.id));
  }

  brandsByIds(brandIds: readonly string[]): Promise<Brand[]> {
    return Promise.resolve(this.brands.filter((found) => brandIds.includes(found.id)));
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    this.#patch(userId, { passwordHash });
  }

  async stageTotpSecret(userId: string, totpSecretEncrypted: string): Promise<boolean> {
    if (this.users.get(userId)?.totpEnabled) return false;
    this.#patch(userId, { totpSecretEncrypted });
    return true;
  }

  async rotateTotpSecret(
    userId: string,
    replacing: string,
    totpSecretEncrypted: string,
  ): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user?.totpEnabled || user.totpSecretEncrypted !== replacing) return false;
    this.#patch(userId, { totpSecretEncrypted });
    return true;
  }

  async enableTotp(userId: string, recoveryCodesHashed: string[]): Promise<void> {
    this.#patch(userId, { totpEnabled: true, recoveryCodesHashed });
  }

  async replaceRecoveryCodes(userId: string, recoveryCodesHashed: string[]): Promise<void> {
    this.#patch(userId, { recoveryCodesHashed });
  }

  async disableTotp(
    userId: string,
    _tx?: unknown,
    options: { readonly keepRecoveryCodes?: boolean } = {},
  ): Promise<void> {
    this.#patch(userId, {
      totpEnabled: false,
      totpSecretEncrypted: null,
      ...(options.keepRecoveryCodes ? {} : { recoveryCodesHashed: [] }),
    });
  }

  async markActive(userId: string): Promise<void> {
    this.#patch(userId, { status: 'active' });
  }

  #patch(userId: string, changes: Partial<StaffUser>): void {
    const user = this.users.get(userId);
    if (user !== undefined) {
      this.users.set(userId, { ...user, ...changes });
    }
  }
}

/**
 * What the service queued, link in the clear. Sealing it and the outbox row are
 * `auth-email.test.ts`'s business; this suite follows the link.
 */
class CollectingAuthMail implements AuthMail {
  readonly sent: (AuthEmailRequest & { readonly brandId: string | null })[] = [];
  /** Whether the account has a brand to route through; false plays an account with no role. */
  hasBrand = true;

  queue(_tx: DbTransaction, brandId: string, request: AuthEmailRequest): Promise<void> {
    this.sent.push({ ...request, brandId });
    return Promise.resolve();
  }

  queueForAccount(request: AuthEmailRequest): Promise<boolean> {
    if (this.hasBrand) {
      this.sent.push({ ...request, brandId: null });
    }
    return Promise.resolve(this.hasBrand);
  }
}

/** The trail, as a list; that rows reach `audit_log` is the integration suite's to prove. */
class RecordingAudit implements AuthAuditTrail {
  readonly entries: AuthAuditEntry[] = [];

  record(entry: AuthAuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }
}

/** Enabled for neither provider unless a test says otherwise. */
class FakeOauthService {
  enabled = false;
  identity: OauthIdentity | Error = new OauthError('nope');
  /** Set to finish a connect flow that this account started, instead of a sign-in. */
  linkUserId: string | undefined;
  /** Set to finish a flow started from an invitation. */
  invite: OauthInviteState | undefined;
  /** What each `start` was asked to carry in its state. */
  readonly started: unknown[] = [];

  isEnabled(): Promise<boolean> {
    return Promise.resolve(this.enabled);
  }

  start(_provider: string, carried: unknown = {}): Promise<{ url: string; browserNonce: string }> {
    this.started.push(carried);
    if (!this.enabled) {
      throw new OauthError('not configured');
    }
    return Promise.resolve({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      browserNonce: 'nonce-1',
    });
  }

  complete(): Promise<OauthCompletion> {
    if (this.identity instanceof Error) {
      return Promise.reject(this.identity);
    }
    return Promise.resolve({
      identity: this.identity,
      linkUserId: this.linkUserId,
      invite: this.invite,
    });
  }
}

/** `user_oauth_identities` in memory; the real table is exercised in oauth-identity.integration.test.ts. */
class FakeOauthIdentities {
  readonly links: OauthLink[] = [];

  userFor(provider: string, subject: string): Promise<string | undefined> {
    return Promise.resolve(
      this.links.find((link) => link.provider === provider && link.subject === subject)?.userId,
    );
  }

  hasProvider(userId: string, provider: string): Promise<boolean> {
    return Promise.resolve(
      this.links.some((link) => link.userId === userId && link.provider === provider),
    );
  }

  ofUser(userId: string): Promise<{ provider: string; providerSubject: string }[]> {
    return Promise.resolve(
      this.links
        .filter((link) => link.userId === userId)
        .map((link) => ({ provider: link.provider, providerSubject: link.subject })),
    );
  }

  link(link: OauthLink): Promise<'linked'> {
    this.links.push(link);
    return Promise.resolve('linked');
  }

  /** The transaction's behaviour in memory: replace a stranded Microsoft row, or say why not. */
  async replaceStrandedMicrosoft({
    link,
    acceptedTenants,
    afterReplace,
  }: {
    link: OauthLink;
    acceptedTenants: readonly string[];
    afterReplace(tx: DbTransaction): Promise<void>;
  }): Promise<'replaced' | 'none' | 'conflict'> {
    const index = this.links.findIndex(
      (existing) => existing.userId === link.userId && existing.provider === 'microsoft',
    );
    const existing = this.links[index];
    if (existing === undefined) {
      return 'none';
    }
    if (acceptedTenants.includes(existing.subject.split(':')[0] ?? '')) {
      return 'conflict';
    }
    this.links.splice(index, 1, link);
    await afterReplace({} as DbTransaction);
    return 'replaced';
  }

  readonly used: string[] = [];

  markUsed(_provider: string, subject: string): Promise<void> {
    this.used.push(subject);
    return Promise.resolve();
  }
}

const googleIdentity = (overrides: Partial<OauthIdentity> = {}): OauthIdentity => ({
  provider: 'google',
  subject: '1049',
  email: 'lina@helpdock.com',
  name: 'Lina',
  authoritative: true,
  hostedDomain: 'helpdock.com',
  verifiedEmails: ['lina@helpdock.com'],
  ...overrides,
});

let stub: RedisStub;
let staff: FakeStaffRepository;
let oauth: FakeOauthService;
let oauthIdentities: FakeOauthIdentities;
let mail: CollectingAuthMail;
let audit: RecordingAudit;
let settings: Settings;
/** Transactions the fake pool opened; a route that holds a transaction must add none. */
let poolTransactions = 0;
/** A request transaction whose queries find nothing. */
let requestTx: DbTransaction;
let service: AuthService;
let hasher: PasswordHasher;
let sessions: SessionService;
let rpIdPin: MemoryRpIdPin;
let passkeyCounts: Map<string, number>;
let passkeyRows: FakePasskeys;
let webauthn: WebAuthnService;
let limiter: RateLimiter;
let rotations: TotpRotationStore;
let signingKeys: SigningKeys;

/**
 * `webauthn_credentials` in memory. A count set by hand (`passkeyCounts`) stands
 * for passkeys the test never signs with; `rows` are the ones it does.
 */
class FakePasskeys {
  rows: WebauthnCredential[] = [];
  /** What the repository was asked, in order, to prove the lock comes first. */
  readonly calls: string[] = [];

  count = (userId: string): Promise<number> => {
    this.calls.push('count');
    return Promise.resolve(
      (passkeyCounts.get(userId) ?? 0) + this.rows.filter((row) => row.userId === userId).length,
    );
  };
  ofUser = (userId: string) => Promise.resolve(this.rows.filter((row) => row.userId === userId));
  byCredentialId = (credentialId: Uint8Array) =>
    Promise.resolve(
      this.rows.find((row) => Buffer.from(row.credentialId).equals(Buffer.from(credentialId))),
    );
  lockAccount = () => {
    this.calls.push('lock');
    return Promise.resolve();
  };
  userHandle = () => Promise.resolve(new Uint8Array(randomBytes(32)));
  transaction = <T>(run: (tx: DbTransaction) => Promise<T>) => run({} as DbTransaction);
  markUsed = (credentialId: Uint8Array, signCount: number, backedUp: boolean) => {
    const row = this.rows.find((found) =>
      Buffer.from(found.credentialId).equals(Buffer.from(credentialId)),
    );
    if (row) Object.assign(row, { signCount, backedUp, lastUsedAt: new Date() });
    return Promise.resolve();
  };
  add = (
    userId: string,
    name: string,
    passkey: { credentialId: Uint8Array; publicKey: Uint8Array },
  ) => {
    const row = credentialRow(userId, name, passkey.credentialId, passkey.publicKey);
    this.rows.push(row);
    return Promise.resolve(row);
  };
}

const credentialRow = (
  userId: string,
  name: string,
  credentialId: Uint8Array,
  publicKey: Uint8Array,
): WebauthnCredential => ({
  id: uuidv7(),
  userId,
  credentialId,
  publicKey,
  algorithm: -7,
  signCount: 0,
  transports: ['internal'],
  aaguid: null,
  discoverable: true,
  backupEligible: false,
  backedUp: false,
  userVerified: true,
  name,
  createdAt: new Date(),
  lastUsedAt: null,
});

const newUser = async (overrides: Partial<StaffUser> = {}): Promise<StaffUser> => ({
  id: uuidv7(),
  email: 'lina@helpdock.com',
  name: 'Lina Haddad',
  passwordHash: await hasher.hash(PASSWORD),
  totpSecretEncrypted: null,
  totpEnabled: false,
  recoveryCodesHashed: [],
  locale: 'en',
  status: 'active',
  installAdmin: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  deactivatedAt: null,
  signatureEn: null,
  signatureAr: null,
  webauthnUserHandle: null,
  singleKeyShortcuts: true,
  publicName: null,
  jobTitleEn: null,
  jobTitleAr: null,
  publicPhone: null,
  photoKey: null,
  timeZone: null,
  ...overrides,
});

const withTotp = async (
  overrides: Partial<StaffUser> = {},
): Promise<{
  user: StaffUser;
  secret: string;
}> => {
  const secret = newTotpSecret();
  const user = await newUser({
    totpEnabled: true,
    totpSecretEncrypted: encryptSecret(secret, createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 })),
    ...overrides,
  });

  return { user, secret };
};

const signIn = (overrides: Partial<Parameters<AuthService['signIn']>[0]> = {}) =>
  service.signIn({
    email: 'lina@helpdock.com',
    password: PASSWORD,
    ip: '203.0.113.5',
    userAgent: 'Firefox',
    trustedDeviceCookie: undefined,
    ...overrides,
  });

beforeEach(async () => {
  const created = authRedis();
  stub = created.stub;
  staff = new FakeStaffRepository();
  oauth = new FakeOauthService();
  oauthIdentities = new FakeOauthIdentities();
  mail = new CollectingAuthMail();
  audit = new RecordingAudit();
  hasher = new PasswordHasher(MASTER_KEY);
  rpIdPin = new MemoryRpIdPin();
  passkeyCounts = new Map();
  passkeyRows = new FakePasskeys();

  settings = createSettings({
    env: {},
    store: new InMemorySettingsStore(),
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }),
    invalidation: {
      subscribe: () => () => {},
      publish: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
  });

  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  signingKeys = { kid: 'k1', privateKey, publicKey };
  const repository = staff as unknown as StaffRepository;
  const refresh = new RefreshStore(created.redis);
  limiter = new RateLimiter(created.redis);

  sessions = new SessionService({
    staff: repository,
    refresh,
    redis: created.redis,
    keys: signingKeys,
    logger: silentLogger(),
    appUrl: APP_URL,
    settings,
  });
  // The database boundary is empty in these pre-SSO auth unit scenarios.
  // SSO persistence and enforcement are exercised with real databases in
  // identity.integration.test.ts; no query behavior is asserted here.
  const emptyRows = () => Object.assign(Promise.resolve([]), { where: () => Promise.resolve([]) });
  const emptyTx = { select: () => ({ from: emptyRows }), execute: () => Promise.resolve([]) };
  requestTx = emptyTx as unknown as DbTransaction;
  poolTransactions = 0;
  const emptyDb = {
    ...emptyTx,
    transaction: (callback: (tx: DbTransaction) => Promise<unknown>) => {
      poolTransactions += 1;
      return callback(emptyTx as unknown as DbTransaction);
    },
  } as unknown as Db;
  rotations = new TotpRotationStore(created.redis);
  webauthn = new WebAuthnService({
    appUrl: APP_URL,
    ceremonies: new WebAuthnCeremonyStore(created.redis),
    pin: rpIdPin,
  });
  service = new AuthService({
    sso: new SsoIdentityService({ db: emptyDb, sessions, redis: created.redis, settings }),
    ssoPolicy: new SsoSignInPolicy({
      db: emptyDb,
      settings,
      keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }),
    }),
    staff: repository,
    sessions,
    hasher,
    challenges: new TotpChallengeStore(created.redis),
    steps: new TotpStepStore(created.redis),
    rotations,
    trustedDevices: new TrustedDeviceStore({ redis: created.redis, masterKey: MASTER_KEY }),
    tokens: new EmailTokenStore(created.redis),
    exchanges: new ExchangeStore(created.redis),
    limiter,
    oauth: oauth as unknown as OauthService,
    oauthIdentities: oauthIdentities as unknown as OauthIdentityRepository,
    webauthn,
    passkeys: passkeyRows as unknown as PasskeyRepository,
    settings,
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }),
    mail,
    audit,
    logger: silentLogger(),
    appUrl: APP_URL,
  });

  // A sender exists, as in an install that took the wizard's step 3: the email
  // requests are honest about its absence only when it is gone (#369).
  await settings.set('smtp.host', 'smtp.example.com', { updatedBy: 'test' });
  await settings.set('smtp.from', 'no-reply@helpdock.com', { updatedBy: 'test' });
});

describe('methods', () => {
  it('reports a provider with no client id as off', async () => {
    await expect(service.methods()).resolves.toEqual({
      sso: [],
      ssoEnforced: false,
      password: true,
      magicLink: true,
      oauth: { google: false, microsoft: false, github: false },
      passkey: true,
      passkeysPaused: false,
    });
  });

  it('reports passkeys as paused, not offered, once APP_URL has moved host', async () => {
    rpIdPin.pinned = { rpId: 'old-desk.example.com', pinnedAt: new Date() };

    await expect(service.methods()).resolves.toMatchObject({
      passkey: false,
      passkeysPaused: true,
    });
  });

  it('reports one that is configured as on', async () => {
    oauth.enabled = true;

    await expect(service.methods()).resolves.toMatchObject({
      oauth: { google: true, microsoft: true, github: true },
    });
  });
});

describe('signIn', () => {
  it('issues a session when there is no second factor and none is required', async () => {
    staff.add(await newUser());

    await expect(signIn()).resolves.toMatchObject({ kind: 'session' });
  });

  it('asks for the second factor when the account has one', async () => {
    const { user } = await withTotp();
    staff.add(user);

    await expect(signIn()).resolves.toMatchObject({
      kind: 'totp-required',
      email: user.email,
    });
  });

  it('sends an account with no authenticator to enrolment when the install requires one', async () => {
    staff.add(await newUser());
    await settings.set('auth.require2fa', true, { updatedBy: 'test' });

    await expect(signIn()).resolves.toMatchObject({ kind: 'second-factor-enrolment-required' });
  });

  it('skips the second factor on a browser that was trusted', async () => {
    const { user } = await withTotp();
    staff.add(user);
    const trustedDeviceCookie = await new TrustedDeviceStore({
      redis: stub.asRedis(),
      masterKey: MASTER_KEY,
    }).trust(user.id);

    await expect(signIn({ trustedDeviceCookie })).resolves.toMatchObject({ kind: 'session' });
  });

  it.each([
    ['a wrong password', { password: 'nope' }],
    ['an unknown address', { email: 'nobody@helpdock.com' }],
  ])('refuses %s with the same code', async (_case, overrides) => {
    staff.add(await newUser());

    await expect(signIn(overrides)).rejects.toMatchObject({
      auth: { code: 'invalid-credentials' },
    });
  });

  it('refuses an account that has no password, without saying that is why', async () => {
    staff.add(await newUser({ passwordHash: null }));

    await expect(signIn()).rejects.toMatchObject({ auth: { code: 'invalid-credentials' } });
  });

  it('refuses a deactivated account by any route (DOMAIN-RULES §12)', async () => {
    staff.add(await newUser({ status: 'deactivated' }));

    await expect(signIn()).rejects.toMatchObject({ auth: { code: 'invalid-credentials' } });
  });

  it('refuses an account with no brand role: there is nothing to sign in to', async () => {
    const user = await newUser();
    staff.users.set(user.id, user);

    await expect(signIn()).rejects.toMatchObject({ auth: { code: 'no-account' } });
  });

  it('activates an invited account the first time it proves an identity', async () => {
    const user = await newUser({ status: 'invited' });
    staff.add(user);

    await signIn();

    expect(staff.users.get(user.id)?.status).toBe('active');
  });

  it('replaces a hash made with weaker parameters, on the one request that can', async () => {
    // What an older release, or another tool, might have written: the same
    // pepper, so it still verifies, but a cost nobody would choose today.
    const legacy = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 4_096,
      timeCost: 1,
      parallelism: 1,
      secret: derivePepper(MASTER_KEY),
    });
    const user = staff.add(await newUser({ passwordHash: legacy }));

    await signIn();

    expect(staff.users.get(user.id)?.passwordHash).toContain('m=19456');
  });

  it('answers "rate-limited" once the per-address budget is spent', async () => {
    staff.add(await newUser());

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await signIn({ password: 'nope' }).catch(() => undefined);
    }

    await expect(signIn()).rejects.toMatchObject({ auth: { code: 'rate-limited' } });
  });

  it('gives the budget back to an address that signs in successfully', async () => {
    staff.add(await newUser());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await signIn({ password: 'nope' }).catch(() => undefined);
    }
    await signIn();

    await expect(signIn()).resolves.toMatchObject({ kind: 'session' });
  });

  it('says an account is locked only after the password is proved', async () => {
    const { user } = await withTotp();
    staff.add(user);
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service
        .verifyTotp({
          ip: '203.0.113.5',
          challengeId: started.challengeId,
          code: '000000',
          trustDevice: false,
          userAgent: undefined,
        })
        .catch(() => undefined);
    }

    await expect(signIn({ password: 'nope' })).rejects.toMatchObject({
      auth: { code: 'invalid-credentials' },
    });
    await expect(signIn()).rejects.toMatchObject({ auth: { code: 'totp-locked' } });
  });
});

describe('verifyTotp', () => {
  const start = async (): Promise<{ challengeId: string; secret: string; user: StaffUser }> => {
    const { user, secret } = await withTotp();
    staff.add(user);
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }

    return { challengeId: started.challengeId, secret, user };
  };

  it('issues a session for the current code', async () => {
    const { challengeId, secret } = await start();

    const { issued, trustedDeviceCookie } = await service.verifyTotp({
      ip: '203.0.113.5',
      challengeId,
      code: await generate({ secret }),
      trustDevice: false,
      userAgent: 'Firefox',
    });

    expect(issued.session.user.email).toBe('lina@helpdock.com');
    expect(trustedDeviceCookie).toBeNull();
  });

  it('mints a trusted-device cookie only when it was asked for', async () => {
    const { challengeId, secret } = await start();

    const { trustedDeviceCookie } = await service.verifyTotp({
      ip: '203.0.113.5',
      challengeId,
      code: await generate({ secret }),
      trustDevice: true,
      userAgent: 'Firefox',
    });

    expect(trustedDeviceCookie).toMatch(/^[0-9a-f-]+\..+\..+$/);
  });

  it('spends the challenge, so one code opens one session', async () => {
    const { challengeId, secret } = await start();
    const code = await generate({ secret });
    await service.verifyTotp({
      ip: '203.0.113.5',
      challengeId,
      code,
      trustDevice: false,
      userAgent: undefined,
    });

    await expect(
      service.verifyTotp({
        ip: '203.0.113.5',
        challengeId,
        code,
        trustDevice: false,
        userAgent: undefined,
      }),
    ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
  });

  it('counts wrong codes down and then locks', async () => {
    const { challengeId } = await start();
    const codes: unknown[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service
        .verifyTotp({
          ip: '203.0.113.5',
          challengeId,
          code: '000000',
          trustDevice: false,
          userAgent: undefined,
        })
        .catch((error: AuthFailure) => {
          codes.push(error.auth);
        });
    }

    expect(codes).toEqual([
      { code: 'totp-mismatch', attemptsLeft: 2 },
      { code: 'totp-mismatch', attemptsLeft: 1 },
      { code: 'totp-locked' },
    ]);
  });

  it('still verifies after junk passwords exhaust the address budget (#343)', async () => {
    const { challengeId, secret } = await start();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await signIn({ password: 'nope', ip: '198.51.100.7' }).catch(() => undefined);
    }
    await expect(signIn({ password: 'nope', ip: '198.51.100.8' })).rejects.toMatchObject({
      auth: { code: 'rate-limited' },
    });

    await expect(
      service.verifyTotp({
        ip: '203.0.113.5',
        challengeId,
        code: await generate({ secret }),
        trustDevice: false,
        userAgent: undefined,
      }),
    ).resolves.toMatchObject({ issued: expect.anything() });
  });

  it('does not charge wrong codes to the address budget, and still locks after three (#343)', async () => {
    const { challengeId } = await start();
    const codes: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service
        .verifyTotp({
          ip: '203.0.113.5',
          challengeId,
          code: '000000',
          trustDevice: false,
          userAgent: undefined,
        })
        .catch((error: AuthFailure) => codes.push(error.auth.code));
    }
    expect(codes).toEqual(['totp-mismatch', 'totp-mismatch', 'totp-locked']);

    // Ten password failures are still allowed: the three bad codes spent none.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(signIn({ password: 'nope', ip: '198.51.100.7' })).rejects.toMatchObject({
        auth: { code: 'invalid-credentials' },
      });
    }
  });

  it('refuses a challenge that was never issued', async () => {
    await expect(
      service.verifyTotp({
        ip: '203.0.113.5',
        challengeId: 'made-up',
        code: '000000',
        trustDevice: false,
        userAgent: undefined,
      }),
    ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
  });

  it('refuses when the stored secret cannot be decrypted, rather than 500', async () => {
    const { user } = await withTotp();
    staff.add({ ...user, totpSecretEncrypted: 'v1.deadbeef.aa.bb.cc' });
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }

    await expect(
      service.verifyTotp({
        ip: '203.0.113.5',
        challengeId: started.challengeId,
        code: '000000',
        trustDevice: false,
        userAgent: undefined,
      }),
    ).rejects.toMatchObject({ auth: { code: 'totp-mismatch' } });
  });
});

describe('useRecoveryCode', () => {
  it('signs in once with a code and then refuses it', async () => {
    const { user, secret } = await withTotp();
    staff.add(user);
    const codes = await service.confirmTotp(user.id, await generate({ secret }));
    const code = codes.recoveryCodes[0] ?? '';

    const first = await signIn();
    if (first.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }
    await expect(
      service.useRecoveryCode({
        ip: '203.0.113.5',
        challengeId: first.challengeId,
        code,
        userAgent: undefined,
      }),
    ).resolves.toMatchObject({ session: { user: { email: user.email } } });

    const second = await signIn();
    if (second.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }
    await expect(
      service.useRecoveryCode({
        ip: '203.0.113.5',
        challengeId: second.challengeId,
        code,
        userAgent: undefined,
      }),
    ).rejects.toMatchObject({ auth: { code: 'recovery-invalid' } });
  });

  it('spends the same attempt budget as the authenticator form', async () => {
    const { user } = await withTotp();
    staff.add(user);
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }

    await service
      .useRecoveryCode({
        ip: '203.0.113.5',
        challengeId: started.challengeId,
        code: 'RC-0000-0000',
        userAgent: undefined,
      })
      .catch(() => undefined);

    await expect(
      service.verifyTotp({
        ip: '203.0.113.5',
        challengeId: started.challengeId,
        code: '000000',
        trustDevice: false,
        userAgent: undefined,
      }),
    ).rejects.toMatchObject({ auth: { code: 'totp-mismatch', attemptsLeft: 1 } });
  });
});

describe('enrolTotp and confirmTotp', () => {
  it('hands over a URI and a secret, and enables nothing until a code proves it', async () => {
    const user = staff.add(await newUser());

    const enrolment = await service.enrolTotp(user.id);

    expect(enrolment.uri.startsWith('otpauth://totp/')).toBe(true);
    expect(staff.users.get(user.id)?.totpEnabled).toBe(false);
  });

  it('enables the second factor and returns ten recovery codes, once', async () => {
    const user = staff.add(await newUser());
    const enrolment = await service.enrolTotp(user.id);

    const { recoveryCodes } = await service.confirmTotp(
      user.id,
      await generate({ secret: enrolment.secret }),
    );

    expect(recoveryCodes).toHaveLength(10);
    expect(staff.users.get(user.id)?.totpEnabled).toBe(true);
    // Only hashes are stored, so the codes cannot be read back out.
    expect(JSON.stringify(staff.users.get(user.id)?.recoveryCodesHashed)).not.toContain(
      recoveryCodes[0] ?? 'code',
    );
  });

  it('refuses a wrong code at confirmation', async () => {
    const user = staff.add(await newUser());
    await service.enrolTotp(user.id);

    await expect(service.confirmTotp(user.id, '000000')).rejects.toMatchObject({
      auth: { code: 'totp-mismatch' },
    });
  });

  it('refuses to confirm before anything was staged', async () => {
    const user = staff.add(await newUser());

    await expect(service.confirmTotp(user.id, '000000')).rejects.toMatchObject({
      auth: { code: 'totp-mismatch' },
    });
  });

  it('refuses an account that is not there', async () => {
    await expect(service.enrolTotp(uuidv7())).rejects.toMatchObject({
      auth: { code: 'no-account' },
    });
  });
});

describe('the magic link', () => {
  const IP = '203.0.113.5';
  const consume = (token: string) =>
    service.consumeMagicLink({ token, ip: IP, userAgent: 'Firefox' });
  const preview = (token: string) => service.previewMagicLink({ token, ip: IP });
  const requestLink = async (email = 'lina@helpdock.com'): Promise<string> => {
    await service.requestMagicLink({ email, ip: IP });
    return tokenIn(mail.sent.at(-1)?.url ?? '');
  };

  it('sends nothing for an address nobody has', async () => {
    await service.requestMagicLink({ email: 'nobody@helpdock.com', ip: IP });

    expect(mail.sent).toEqual([]);
  });

  it('queues one link to the confirm screen, with the token in the fragment', async () => {
    const user = staff.add(await newUser());

    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP });

    expect(mail.sent).toEqual([
      {
        kind: 'magicLink',
        userId: user.id,
        url: expect.stringMatching(
          /^https:\/\/support\.example\.com\/sign-in\/magic#token=[A-Za-z0-9_-]{43}$/,
        ),
        expiresIn: 10,
        brandId: null,
      },
    ]);
  });

  it('queues nothing, and still resolves, for an account with no brand to work in', async () => {
    staff.add(await newUser());
    mail.hasBrand = false;

    await expect(
      service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP }),
    ).resolves.toBeUndefined();
    expect(mail.sent).toEqual([]);
  });

  it('previews whose account the link opens, and the preview spends nothing (M9-01 F6)', async () => {
    staff.add(await newUser());
    const token = await requestLink();

    await expect(preview(token)).resolves.toEqual({
      email: 'lina@helpdock.com',
      expiresInMinutes: 10,
    });
    await expect(preview(token)).resolves.toMatchObject({ email: 'lina@helpdock.com' });
    await expect(consume(token)).resolves.toMatchObject({ kind: 'session' });
  });

  it('previews nothing for a token it never issued', async () => {
    await expect(preview('made-up')).rejects.toMatchObject({
      auth: { code: 'challenge-expired' },
    });
  });

  it('signs in once and then the link is spent', async () => {
    staff.add(await newUser());
    const token = await requestLink();

    await expect(consume(token)).resolves.toMatchObject({ kind: 'session' });
    await expect(consume(token)).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
    await expect(preview(token)).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
  });

  it('refuses a link whose lifetime has passed, to the preview and to the click', async () => {
    staff.add(await newUser());
    const token = await requestLink();

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      await expect(preview(token)).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
      await expect(consume(token)).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a refused link in the audit trail without naming anybody', async () => {
    await expect(consume('made-up')).rejects.toMatchObject({
      auth: { code: 'challenge-expired' },
    });

    expect(audit.entries.at(-1)).toEqual({
      action: 'auth.sign_in.failed',
      userId: null,
      actor: 'system',
      meta: { method: 'magic-link', reason: 'invalid-link' },
    });
  });

  it('still asks for the second factor when the account has one', async () => {
    const { user } = await withTotp();
    staff.add(user);

    await expect(consume(await requestLink(user.email))).resolves.toMatchObject({
      kind: 'totp-required',
    });
  });

  it('refuses a link belonging to an account that has since been deactivated', async () => {
    const user = staff.add(await newUser());
    const token = await requestLink(user.email);
    staff.users.set(user.id, { ...user, status: 'deactivated' });

    await expect(preview(token)).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
    await expect(consume(token)).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
  });

  it('stops answering one address once its lookup budget is spent', async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await preview('made-up').catch(() => undefined);
    }

    await expect(preview('made-up')).rejects.toMatchObject({ auth: { code: 'unavailable' } });
    await expect(consume('made-up')).rejects.toMatchObject({ auth: { code: 'unavailable' } });
  });

  it('stops sending once the per-address budget is spent', async () => {
    staff.add(await newUser());

    for (let attempt = 0; attempt < 7; attempt += 1) {
      await service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP });
    }

    expect(mail.sent.length).toBeLessThanOrEqual(5);
  });

  it('stops one IP walking many addresses, without spending its sign-in budget (M18-11)', async () => {
    staff.add(await newUser());
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await service.requestPasswordReset({ email: `walker-${attempt}@helpdock.com`, ip: IP });
    }

    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP });

    expect(mail.sent).toEqual([]);
    await expect(signIn({ ip: IP })).resolves.toMatchObject({ kind: 'session' });
  });
});

describe('the invitation', () => {
  it('queues the invite in the caller transaction, for the brand it invites to', async () => {
    const brandId = uuidv7();
    const userId = uuidv7();

    await service.queueInvite({} as DbTransaction, brandId, {
      userId,
      url: `${APP_URL}/invite/t`,
      expiresInDays: 7,
      inviterName: 'Lina',
      brandName: 'Acme',
      roleName: 'Agent',
    });

    expect(mail.sent).toEqual([
      {
        kind: 'invite',
        userId,
        url: `${APP_URL}/invite/t`,
        expiresIn: 7,
        values: { inviter: 'Lina', brandName: 'Acme', role: 'Agent' },
        brandId,
      },
    ]);
  });
});

describe('the password reset', () => {
  it('sends nothing for an address nobody has', async () => {
    await service.requestPasswordReset({ email: 'nobody@helpdock.com', ip: '203.0.113.5' });

    expect(mail.sent).toEqual([]);
  });

  it('changes the password and ends every session', async () => {
    const user = staff.add(await newUser());
    const opened = await signIn();
    if (opened.kind !== 'session') {
      throw new Error('expected a session');
    }
    await service.requestPasswordReset({ email: user.email, ip: '203.0.113.5' });
    const token = resetTokenIn(mail.sent[0]?.url ?? '');

    await service.resetPassword({ token, password: 'a whole new password' });

    expect(
      await hasher.verify(staff.users.get(user.id)?.passwordHash ?? '', 'a whole new password'),
    ).toMatchObject({ valid: true });
    // Everything the old session had is gone.
    expect(stub.keys().some((key) => key.startsWith('sess:family:'))).toBe(false);
  });

  it('refuses a token that was already spent', async () => {
    const user = staff.add(await newUser());
    await service.requestPasswordReset({ email: user.email, ip: '203.0.113.5' });
    const token = resetTokenIn(mail.sent[0]?.url ?? '');
    await service.resetPassword({ token, password: 'a whole new password' });

    await expect(
      service.resetPassword({ token, password: 'another new password' }),
    ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
  });

  it('refuses a magic link presented as a reset token', async () => {
    staff.add(await newUser());
    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' });

    await expect(
      service.resetPassword({
        token: tokenIn(mail.sent[0]?.url ?? ''),
        password: 'a whole new password',
      }),
    ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
  });
});

describe('the sign-in link requests without a system sender (#369)', () => {
  const IP = '203.0.113.8';
  const noSender = async (): Promise<void> => {
    await settings.set('smtp.host', '', { updatedBy: 'test' });
  };

  it('refuses a sign-in link with the same answer for every address, spending nothing', async () => {
    await noSender();
    staff.add(await newUser());

    await expect(
      service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP }),
    ).rejects.toMatchObject({ auth: { code: 'email-unavailable' } });
    // The answer is about the install, never about which addresses exist.
    await expect(
      service.requestMagicLink({ email: 'nobody@helpdock.com', ip: IP }),
    ).rejects.toMatchObject({ auth: { code: 'email-unavailable' } });
    expect(mail.sent).toEqual([]);
  });

  it('refuses a password reset the same way, known address or not', async () => {
    await noSender();
    const user = staff.add(await newUser());

    await expect(service.requestPasswordReset({ email: user.email, ip: IP })).rejects.toMatchObject(
      { auth: { code: 'email-unavailable' } },
    );
    await expect(
      service.requestPasswordReset({ email: 'nobody@helpdock.com', ip: IP }),
    ).rejects.toMatchObject({ auth: { code: 'email-unavailable' } });
    expect(mail.sent).toEqual([]);
  });

  it('answers sso-required, not email-unavailable, when SSO is enforced and no sender is set', async () => {
    await noSender();
    staff.add(await newUser());
    vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValueOnce(true);

    await expect(
      service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP }),
    ).rejects.toMatchObject({ auth: { code: 'sso-required' } });
  });

  it('sends again once the sender exists, with no restart', async () => {
    await noSender();
    staff.add(await newUser());
    await expect(
      service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP }),
    ).rejects.toMatchObject({ auth: { code: 'email-unavailable' } });

    await settings.set('smtp.host', 'smtp.example.com', { updatedBy: 'test' });
    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: IP });

    expect(mail.sent).toHaveLength(1);
  });
});

describe('OAuth', () => {
  it('reports a provider that is not configured as unavailable', async () => {
    await expect(service.startOauth('google')).rejects.toMatchObject({
      auth: { code: 'unavailable' },
    });
  });

  it('hands back the provider URL when it is configured', async () => {
    oauth.enabled = true;

    await expect(service.startOauth('google')).resolves.toEqual({
      url: expect.stringContaining('accounts.google.com'),
      browserNonce: 'nonce-1',
    });
  });

  it('signs in an address Google vouches for, and binds the Google account to it', async () => {
    const lina = await newUser();
    staff.add(lina);
    oauth.identity = googleIdentity();

    await expect(
      service.completeOauth({
        provider: 'google',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      }),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(oauthIdentities.links).toEqual([
      {
        userId: lina.id,
        provider: 'google',
        subject: '1049',
        email: 'lina@helpdock.com',
        via: 'sign-in',
      },
    ]);
    expect(audit.actions()).toContain('auth.oauth.linked');
    expect(mail.sent.map((sent) => sent.values?.change)).toContain('oauthConnected');
  });

  it('records the sign-in on a bound provider account, for the security page', async () => {
    const lina = staff.add(await newUser());
    oauthIdentities.links.push({
      userId: lina.id,
      provider: 'google',
      subject: '1049',
      email: lina.email,
      via: 'connect',
    });
    oauth.identity = googleIdentity();

    await service.completeOauth({
      provider: 'google',
      code: 'c',
      state: 's',
      browserNonce: 'n',
      userAgent: 'Firefox',
    });

    expect(oauthIdentities.used).toEqual(['1049']);
  });

  it('asks a provider that does not vouch for the address to be connected from a session', async () => {
    staff.add(await newUser());
    oauth.identity = googleIdentity({ provider: 'github', subject: '7', authoritative: false });

    await expect(
      service.completeOauth({
        provider: 'github',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      }),
    ).rejects.toMatchObject({ auth: { code: 'oauth-link-required' } });
    expect(oauthIdentities.links).toEqual([]);
  });

  it('refuses an address that belongs to nobody, and creates no account', async () => {
    oauth.identity = googleIdentity({ email: 'stranger@example.com' });

    await expect(
      service.completeOauth({
        provider: 'google',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      }),
    ).rejects.toMatchObject({ auth: { code: 'no-account' } });
    expect(staff.users.size).toBe(0);
  });

  describe('the allowed Workspace domains (oauth.google.allowedDomains)', () => {
    const callback = () =>
      service.completeOauth({
        provider: 'google',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      });

    it('signs in a Workspace account on a listed domain', async () => {
      staff.add(await newUser());
      await settings.set('oauth.google.allowedDomains', ['helpdock.com'], { updatedBy: 'test' });
      oauth.identity = googleIdentity();

      await expect(callback()).resolves.toMatchObject({ kind: 'session' });
    });

    it('refuses a Gmail account once domains are listed, and audits why', async () => {
      staff.add(await newUser({ email: 'lina@gmail.com' }));
      await settings.set('oauth.google.allowedDomains', ['helpdock.com'], { updatedBy: 'test' });
      oauth.identity = googleIdentity({ email: 'lina@gmail.com', hostedDomain: undefined });

      await expect(callback()).rejects.toMatchObject({
        auth: { code: 'oauth-domain-not-allowed' },
      });
      expect(oauthIdentities.links).toEqual([]);
      expect(audit.entries).toContainEqual(
        expect.objectContaining({
          action: 'auth.sign_in.failed',
          userId: null,
          meta: { method: 'oauth', provider: 'google', reason: 'domain-not-allowed' },
        }),
      );
    });

    it('turns away an account bound before the domain was dropped from the list', async () => {
      const lina = staff.add(await newUser());
      oauthIdentities.links.push({
        userId: lina.id,
        provider: 'google',
        subject: '1049',
        email: lina.email,
        via: 'sign-in',
      });
      await settings.set('oauth.google.allowedDomains', ['acme.com'], { updatedBy: 'test' });
      oauth.identity = googleIdentity();

      await expect(callback()).rejects.toMatchObject({
        auth: { code: 'oauth-domain-not-allowed' },
      });
      expect(audit.entries).toContainEqual(
        expect.objectContaining({ action: 'auth.sign_in.failed', userId: lina.id }),
      );
    });

    it('refuses to connect an account from another domain to a session', async () => {
      const lina = staff.add(await newUser());
      await settings.set('oauth.google.allowedDomains', ['helpdock.com'], { updatedBy: 'test' });
      oauth.identity = googleIdentity({ hostedDomain: 'other.com', email: 'lina@other.com' });
      oauth.linkUserId = lina.id;

      await expect(callback()).rejects.toMatchObject({
        auth: { code: 'oauth-domain-not-allowed' },
      });
      expect(oauthIdentities.links).toEqual([]);
      expect(audit.actions()).toEqual(['auth.oauth.link_refused']);
    });

    it('leaves GitHub alone', async () => {
      const lina = staff.add(await newUser());
      await settings.set('oauth.google.allowedDomains', ['helpdock.com'], { updatedBy: 'test' });
      oauth.identity = googleIdentity({
        provider: 'github',
        subject: '7',
        hostedDomain: undefined,
      });
      oauth.linkUserId = lina.id;

      await expect(callback()).resolves.toEqual({ kind: 'connected' });
    });
  });

  it('turns a provider failure into a sign-in failure, not a 500', async () => {
    oauth.identity = new OauthError('the state does not belong to this provider');

    await expect(
      service.completeOauth({
        provider: 'github',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      }),
    ).rejects.toMatchObject({ auth: { code: 'no-account' } });
  });

  it('names a token from another Microsoft tenant, audits it, and says nothing of accounts', async () => {
    staff.add(await newUser());
    oauth.identity = new OauthError(
      'The id token is from another Microsoft tenant',
      'tenant-mismatch',
    );

    await expect(
      service.completeOauth({
        provider: 'microsoft',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      }),
    ).rejects.toMatchObject({ auth: { code: 'oauth-tenant-mismatch' } });
    expect(audit.entries).toContainEqual(
      expect.objectContaining({
        action: 'auth.sign_in.failed',
        userId: null,
        meta: { method: 'oauth', provider: 'microsoft', reason: 'tenant-mismatch' },
      }),
    );
    expect(oauthIdentities.links).toEqual([]);
  });

  describe('Microsoft', () => {
    const microsoftIdentity = (overrides: Partial<OauthIdentity> = {}): OauthIdentity =>
      googleIdentity({
        provider: 'microsoft',
        subject: 'tenant:oid',
        hostedDomain: undefined,
        ...overrides,
      });
    const callback = () =>
      service.completeOauth({
        provider: 'microsoft',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      });

    describe('a person whose only Microsoft identity is of a tenant the install stopped accepting', () => {
      const OLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
      const NEW = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

      const stranded = async () => {
        const lina = staff.add(await newUser());
        await settings.set('oauth.microsoft.tenantId', NEW, { updatedBy: 'test' });
        oauthIdentities.links.push({
          userId: lina.id,
          provider: 'microsoft',
          subject: `${OLD}:oid-1`,
          email: lina.email,
          via: 'sign-in',
        });
        return lina;
      };

      it('replaces it at a first link, with the connected email in the same transaction', async () => {
        const lina = await stranded();
        oauth.identity = microsoftIdentity({ subject: `${NEW}:oid-2` });
        mail.sent.length = 0;

        await callback();

        expect(oauthIdentities.links).toEqual([
          expect.objectContaining({ userId: lina.id, subject: `${NEW}:oid-2` }),
        ]);
        expect(mail.sent).toEqual([
          expect.objectContaining({
            brandId: expect.any(String),
            values: expect.objectContaining({ change: 'oauthConnected', provider: 'Microsoft' }),
          }),
        ]);
      });

      it('replaces it when they connect from a session', async () => {
        const lina = await stranded();
        oauth.identity = microsoftIdentity({ subject: `${NEW}:oid-2`, authoritative: false });
        oauth.linkUserId = lina.id;

        await callback();

        expect(oauthIdentities.links.map((link) => link.subject)).toEqual([`${NEW}:oid-2`]);
      });

      it('lets them start the connect flow instead of answering a conflict', async () => {
        const lina = await stranded();
        oauth.enabled = true;

        await expect(
          service.startOauthConnect({
            userId: lina.id,
            provider: 'microsoft',
            proof: { currentPassword: PASSWORD },
          }),
        ).resolves.toMatchObject({ browserNonce: expect.any(String) });
      });
    });

    it('still answers a conflict when the existing identity is of an accepted tenant', async () => {
      const lina = staff.add(await newUser());
      const tenant = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
      await settings.set('oauth.microsoft.tenantId', tenant, { updatedBy: 'test' });
      oauthIdentities.links.push({
        userId: lina.id,
        provider: 'microsoft',
        subject: `${tenant}:oid-1`,
        email: lina.email,
        via: 'sign-in',
      });
      oauth.identity = microsoftIdentity({ subject: `${tenant}:oid-2` });

      await expect(callback()).rejects.toMatchObject({ auth: { code: 'oauth-identity-conflict' } });
      expect(oauthIdentities.links.map((link) => link.subject)).toEqual([`${tenant}:oid-1`]);
    });

    it('makes the first link when Microsoft vouches for the address, and names the provider in the notice', async () => {
      staff.add(await newUser());
      oauth.identity = microsoftIdentity();

      await callback();

      expect(oauthIdentities.links).toEqual([
        expect.objectContaining({ provider: 'microsoft', subject: 'tenant:oid' }),
      ]);
      expect(mail.sent.at(-1)?.values).toMatchObject({ provider: 'Microsoft' });
    });

    it('asks a member Microsoft does not vouch for, or a guest, to connect from a session', async () => {
      staff.add(await newUser());
      oauth.identity = microsoftIdentity({ authoritative: false, verifiedEmails: [] });

      await expect(callback()).rejects.toMatchObject({ auth: { code: 'oauth-link-required' } });
      expect(oauthIdentities.links).toEqual([]);
    });

    it('signs a bound account in whatever address the token carries, and applies no Google domain list', async () => {
      const lina = await newUser();
      staff.add(lina);
      oauthIdentities.links.push({
        userId: lina.id,
        provider: 'microsoft',
        subject: 'tenant:oid',
        email: 'lina@helpdock.com',
        via: 'sign-in',
      });
      await settings.set('oauth.google.allowedDomains', ['acme.com'], { updatedBy: 'test' });
      oauth.identity = microsoftIdentity({
        email: 'renamed@elsewhere.test',
        authoritative: false,
        verifiedEmails: [],
      });

      await callback();

      expect(oauthIdentities.used).toEqual(['tenant:oid']);
    });
  });

  it('reports an unexpected failure as unavailable rather than as no account', async () => {
    oauth.identity = new TypeError('the network went away');

    await expect(
      service.completeOauth({
        provider: 'github',
        code: 'c',
        state: 's',
        browserNonce: 'n',
        userAgent: 'Firefox',
      }),
    ).rejects.toMatchObject({ auth: { code: 'unavailable' } });
  });
});

describe('accepting an invitation with a provider (M18-07)', () => {
  const INVITE: OauthInviteState = { tokenHash: 'hash-of-the-token', name: 'Nour', locale: 'en' };
  const callback = () =>
    service.completeOauth({
      provider: 'google',
      code: 'c',
      state: 's',
      browserNonce: 'n',
      userAgent: 'Firefox',
    });
  const acceptor = () => {
    const accept = vi.fn<OauthInviteAcceptor['acceptWithProvider']>(() =>
      Promise.resolve({ kind: 'invite-mismatch', account: 'whoever@example.com' }),
    );
    service.acceptInvitesWith({ acceptWithProvider: accept });
    return accept;
  };

  beforeEach(() => {
    oauth.identity = googleIdentity();
    oauth.invite = INVITE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers unavailable while nothing accepts invitations', async () => {
    await expect(callback()).rejects.toMatchObject({ auth: { code: 'unavailable' } });
  });

  it('hands the provider answer and the invitation to the staff module', async () => {
    const accept = acceptor();

    await expect(callback()).resolves.toEqual({
      kind: 'invite-mismatch',
      account: 'whoever@example.com',
    });
    expect(accept).toHaveBeenCalledWith({
      invite: INVITE,
      identity: googleIdentity(),
      userAgent: 'Firefox',
    });
  });

  it('refuses a Google account outside the allowed domains before the invitation is read', async () => {
    const accept = acceptor();
    await settings.set('oauth.google.allowedDomains', ['acme.com'], { updatedBy: 'test' });

    await expect(callback()).rejects.toMatchObject({
      auth: { code: 'oauth-domain-not-allowed' },
    });
    expect(accept).not.toHaveBeenCalled();
    expect(audit.entries).toContainEqual(
      expect.objectContaining({
        action: 'auth.sign_in.failed',
        meta: { method: 'invite', provider: 'google', reason: 'domain-not-allowed' },
      }),
    );
  });

  it('refuses a provider account bound to somebody else before anything is spent', async () => {
    const accept = acceptor();
    const owner = staff.add(await newUser());
    oauthIdentities.links.push({
      userId: owner.id,
      provider: 'google',
      subject: '1049',
      email: owner.email,
      via: 'connect',
    });

    await expect(callback()).rejects.toMatchObject({
      auth: { code: 'oauth-identity-conflict' },
    });
    expect(accept).not.toHaveBeenCalled();
    expect(audit.entries).toContainEqual(
      expect.objectContaining({
        action: 'auth.sign_in.failed',
        userId: owner.id,
        meta: { method: 'invite', provider: 'google', reason: 'identity-conflict' },
      }),
    );
  });

  it('starts the round trip with the invitation in its state, and not under SSO enforcement', async () => {
    oauth.enabled = true;

    await expect(service.startInviteOauth('google', INVITE)).resolves.toMatchObject({
      browserNonce: 'nonce-1',
    });
    expect(oauth.started).toEqual([{ invite: INVITE }]);

    vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
    await expect(service.startInviteOauth('google', INVITE)).rejects.toMatchObject({
      auth: { code: 'sso-required' },
    });
    expect(oauth.started).toHaveLength(1);
  });

  it('reports a provider that is not configured as unavailable', async () => {
    await expect(service.startInviteOauth('github', INVITE)).rejects.toMatchObject({
      auth: { code: 'unavailable' },
    });
  });

  it('binds and emails in the acceptance transaction, and audits only once asked after it', async () => {
    const nour = staff.add(await newUser({ email: 'nour@helpdock.com' }));
    const tx = {} as DbTransaction;

    await service.linkInvitedIdentity(tx, nour.id, googleIdentity({ email: nour.email }));

    expect(oauthIdentities.links).toEqual([
      { userId: nour.id, provider: 'google', subject: '1049', email: nour.email, via: 'invite' },
    ]);
    expect(mail.sent).toEqual([
      expect.objectContaining({
        brandId: BRAND_ID,
        values: expect.objectContaining({ change: 'oauthConnected' }),
      }),
    ]);
    expect(audit.actions()).toEqual([]);

    await service.recordInvitedLink(nour.id, 'google');

    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'auth.oauth.linked',
        userId: nour.id,
        actor: 'staff',
        meta: { provider: 'google', via: 'invite' },
      }),
    ]);
  });
});

describe('the redirect hand-off', () => {
  it('exchanges a one-time code for a session and spends it', async () => {
    staff.add(await newUser());
    const opened = await signIn();
    if (opened.kind !== 'session') {
      throw new Error('expected a session');
    }
    const code = await service.issueExchangeCode(opened.issued);

    await expect(service.exchange(code)).resolves.toMatchObject({
      session: { user: { email: 'lina@helpdock.com' } },
      accessToken: expect.any(String),
    });
    await expect(service.exchange(code)).rejects.toMatchObject({
      auth: { code: 'challenge-expired' },
    });
  });

  it('refuses a code it never issued', async () => {
    await expect(service.exchange('made-up')).rejects.toMatchObject({
      auth: { code: 'challenge-expired' },
    });
  });
});

describe('me and signing out', () => {
  it('describes the session the account holds', async () => {
    const user = staff.add(await newUser(), 'admin');

    await expect(service.me(user.id)).resolves.toMatchObject({
      user: { email: user.email, role: 'admin' },
      brands: [{ ticketPrefix: 'HD' }],
    });
  });

  it('answers null for an account that cannot use the admin', async () => {
    await expect(service.me(uuidv7())).resolves.toBeNull();
  });

  const twoBrowsers = async (): Promise<[string, string]> => {
    const families: string[] = [];
    for (const userAgent of ['Firefox', 'Safari']) {
      const opened = await signIn({ userAgent });
      if (opened.kind !== 'session') {
        throw new Error('expected a session');
      }
      families.push(opened.issued.refreshCookieValue.fam);
    }
    return families as [string, string];
  };

  const revocations = () =>
    stub.published
      .filter((entry) => entry.channel === 'principal.revoked')
      .map((entry) => JSON.parse(entry.message) as Record<string, unknown>);

  it('names the one browser that signed out, so only its sockets close', async () => {
    const user = staff.add(await newUser());
    const [firefox] = await twoBrowsers();

    await sessions.revokeFamily(firefox, 'sign-out');

    expect(revocations()).toEqual([
      { principalType: 'staff', principalId: user.id, reason: 'sign-out', familyIds: [firefox] },
    ]);
  });

  it('names every browser but the kept one after a password change', async () => {
    const user = staff.add(await newUser());
    const [firefox, safari] = await twoBrowsers();

    await sessions.revokeEverythingExcept(user.id, safari, 'password-changed');

    expect(revocations()).toEqual([
      expect.objectContaining({ principalId: user.id, familyIds: [firefox] }),
    ]);
  });

  it('forgets every family and every trusted browser', async () => {
    const { user, secret } = await withTotp();
    staff.add(user);
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }
    await service.verifyTotp({
      ip: '203.0.113.5',
      challengeId: started.challengeId,
      code: await generate({ secret }),
      trustDevice: true,
      userAgent: 'Firefox',
    });

    await service.signOutEverywhere(user.id);

    expect(stub.keys().some((key) => key.startsWith('sess:family:'))).toBe(false);
    expect(stub.keys().some((key) => key.startsWith('auth:trust:'))).toBe(false);
    // What M0-13 listens for, so it can drop that principal's sockets.
    expect(stub.published).toContainEqual({
      channel: 'principal.revoked',
      message: JSON.stringify({
        principalType: 'staff',
        principalId: user.id,
        reason: 'sign-out-everywhere',
      }),
    });
  });
});

describe('a second factor for administrators (ASVS 4.3.1)', () => {
  it('sends an Admin with no authenticator to enrolment, whatever the setting', async () => {
    staff.add(await newUser(), 'admin');

    await expect(signIn()).resolves.toMatchObject({ kind: 'second-factor-enrolment-required' });
  });

  it('does the same for an install admin who is only an agent in their brand', async () => {
    staff.add(await newUser({ installAdmin: true }), 'agent');

    await expect(signIn()).resolves.toMatchObject({ kind: 'second-factor-enrolment-required' });
  });

  it('leaves an agent to choose, while the install does not require it', async () => {
    staff.add(await newUser(), 'agent');

    await expect(signIn()).resolves.toMatchObject({ kind: 'session' });
  });

  it('refuses to let an Admin turn their second factor off', async () => {
    const { user, secret } = await withTotp();
    staff.add(user, 'admin');

    await expect(service.disableTotp(user.id, await generate({ secret }))).rejects.toMatchObject({
      auth: { code: 'unavailable' },
    });
    expect(staff.users.get(user.id)?.totpEnabled).toBe(true);
  });

  it('reports the rule to the security page', async () => {
    const admin = staff.add(await newUser(), 'admin');
    const agent = staff.add(await newUser({ email: 'sami@helpdock.com' }), 'agent');

    await expect(service.secondFactorRequiredFor(admin.id)).resolves.toBe(true);
    await expect(service.secondFactorRequiredFor(agent.id)).resolves.toBe(false);
  });
});

describe('enrolment from a challenge', () => {
  const challenge = async (): Promise<string> => {
    staff.add(await newUser(), 'admin');
    const started = await signIn();
    if (started.kind !== 'second-factor-enrolment-required') {
      throw new Error('expected an enrolment challenge');
    }
    return started.challengeId;
  };

  it('stages a secret, turns it on, and opens the session the challenge stood in for', async () => {
    const challengeId = await challenge();
    const { secret } = await service.startEnrolment(challengeId);

    const { recoveryCodes, issued } = await service.completeEnrolment({
      ip: '203.0.113.5',
      challengeId,
      code: await generate({ secret }),
      userAgent: 'Firefox',
    });

    expect(recoveryCodes).toHaveLength(10);
    expect(issued.session.user.email).toBe('lina@helpdock.com');
    expect([...staff.users.values()][0]?.totpEnabled).toBe(true);
    expect(audit.actions()).toEqual(['auth.second_factor.enabled', 'auth.sign_in.succeeded']);
    expect(audit.entries[1]?.meta).toMatchObject({ method: 'password', secondFactor: 'totp' });
  });

  it('spends the challenge, so it cannot enrol twice', async () => {
    const challengeId = await challenge();
    const { secret } = await service.startEnrolment(challengeId);
    await service.completeEnrolment({
      ip: '203.0.113.5',
      challengeId,
      code: await generate({ secret }),
      userAgent: undefined,
    });

    await expect(service.startEnrolment(challengeId)).rejects.toMatchObject({
      auth: { code: 'challenge-expired' },
    });
  });

  it('charges a wrong code an attempt, as a sign-in does', async () => {
    const challengeId = await challenge();
    await service.startEnrolment(challengeId);

    await expect(
      service.completeEnrolment({
        ip: '203.0.113.5',
        challengeId,
        code: '000000',
        userAgent: undefined,
      }),
    ).rejects.toMatchObject({ auth: { code: 'totp-mismatch', attemptsLeft: 2 } });
  });

  it('will not take a second-factor challenge in place of an enrolment one', async () => {
    const { user } = await withTotp();
    staff.add(user);
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }

    await expect(service.startEnrolment(started.challengeId)).rejects.toMatchObject({
      auth: { code: 'challenge-expired' },
    });
  });
});

describe('a code is accepted once (ASVS 2.8.4, 2.8.5)', () => {
  const challengeFor = async (): Promise<string> => {
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }
    return started.challengeId;
  };

  const verify = async (code: string) =>
    service.verifyTotp({
      ip: '203.0.113.5',
      challengeId: await challengeFor(),
      code,
      trustDevice: false,
      userAgent: undefined,
    });

  it('refuses the same code at a second challenge, and records that it was replayed', async () => {
    const { user, secret } = await withTotp();
    staff.add(user);
    const code = await generate({ secret });
    await verify(code);

    await expect(verify(code)).rejects.toMatchObject({
      auth: { code: 'totp-mismatch', attemptsLeft: 2 },
    });
    expect(audit.actions()).toContain('auth.second_factor.replayed');
  });

  it('refuses an older code once a newer one has been used', async () => {
    const { user, secret } = await withTotp();
    staff.add(user);
    const now = Math.floor(Date.now() / 1000);
    await verify(await generate({ secret, epoch: now }));

    await expect(verify(await generate({ secret, epoch: now - 30 }))).rejects.toMatchObject({
      auth: { code: 'totp-mismatch' },
    });
  });

  it('will not let the code that just signed in also turn the second factor off', async () => {
    const { user, secret } = await withTotp();
    staff.add(user);
    const code = await generate({ secret });
    await verify(code);

    await expect(service.disableTotp(user.id, code)).rejects.toMatchObject({
      auth: { code: 'totp-mismatch' },
    });
  });
});

describe('breached passwords (ASVS 2.1.7)', () => {
  it('refuses one on a change, whatever its case, and keeps the old password', async () => {
    const user = staff.add(await newUser());

    await expect(
      service.changePassword({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: 'QwertyUIOP123',
        keepFamilyId: null,
      }),
    ).rejects.toMatchObject({ auth: { code: 'password-breached' } });
    expect(
      await hasher.verify(staff.users.get(user.id)?.passwordHash ?? '', PASSWORD),
    ).toMatchObject({ valid: true });
  });

  it('refuses one on a reset before the link is spent, so the link still works', async () => {
    const user = staff.add(await newUser());
    await service.requestPasswordReset({ email: user.email, ip: '203.0.113.5' });
    const token = resetTokenIn(mail.sent[0]?.url ?? '');

    await expect(
      service.resetPassword({ token, password: 'passwordpassword' }),
    ).rejects.toMatchObject({ auth: { code: 'password-breached' } });
    await expect(
      service.resetPassword({ token, password: 'a whole new password' }),
    ).resolves.toBeUndefined();
  });

  it('refuses one for a new account, which is how an invitation sets its first', () => {
    expect(() => service.hashPassword('iloveyou1234')).toThrow(
      expect.objectContaining({ auth: { code: 'password-breached' } }),
    );
  });
});

describe('telling the account holder a credential changed (ASVS 2.2.3, 2.5.5)', () => {
  const changeNotices = () => mail.sent.filter((sent) => sent.kind === 'securityChange');

  it('queues a notice in the request transaction when the password is changed', async () => {
    const user = staff.add(await newUser());

    await service.changePassword({
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: 'a whole new password',
      keepFamilyId: null,
      tx: {} as DbTransaction,
    });

    expect(changeNotices()).toEqual([
      expect.objectContaining({
        userId: user.id,
        brandId: BRAND_ID,
        url: `${APP_URL}/me/security`,
        values: { change: 'password', occurredAt: expect.any(String) },
      }),
    ]);
  });

  it('sends one after a reset, which has no transaction to join', async () => {
    const user = staff.add(await newUser());
    await service.requestPasswordReset({ email: user.email, ip: '203.0.113.5' });

    await service.resetPassword({
      token: resetTokenIn(mail.sent[0]?.url ?? ''),
      password: 'a whole new password',
    });

    expect(changeNotices()).toEqual([
      expect.objectContaining({
        userId: user.id,
        brandId: null,
        values: { change: 'passwordReset', occurredAt: expect.any(String) },
      }),
    ]);
  });

  it('names the passkeys a reset kept, because a reset proves the mailbox and removes none', async () => {
    const user = staff.add(await newUser());
    passkeyCounts.set(user.id, 2);
    await service.requestPasswordReset({ email: user.email, ip: '203.0.113.5' });

    await service.resetPassword({
      token: resetTokenIn(mail.sent[0]?.url ?? ''),
      password: 'a whole new password',
    });

    expect(changeNotices()).toEqual([
      expect.objectContaining({
        values: { change: 'passwordReset', passkeys: '2', occurredAt: expect.any(String) },
      }),
    ]);
  });

  it('sends one when the second factor goes on, comes off, or its codes are redrawn', async () => {
    const user = staff.add(await newUser());
    const { secret } = await service.enrolTotp(user.id);
    const now = Math.floor(Date.now() / 1000);
    await service.confirmTotp(user.id, await generate({ secret, epoch: now - 30 }));
    await service.regenerateRecoveryCodes(user.id, await generate({ secret, epoch: now }));
    await service.disableTotp(user.id, await generate({ secret, epoch: now + 30 }));

    expect(changeNotices().map((sent) => sent.values?.change)).toEqual([
      'twoFactorEnabled',
      'recoveryCodes',
      'twoFactorDisabled',
    ]);
    expect(audit.actions()).toEqual([
      'auth.second_factor.enabled',
      'auth.recovery_codes.regenerated',
      'auth.second_factor.disabled',
    ]);
  });
});

describe('the audit trail of a sign-in (ASVS 7.1.3, 7.2.1)', () => {
  it('records a success with the way in', async () => {
    const user = staff.add(await newUser());

    await signIn();

    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in.succeeded',
        userId: user.id,
        actor: 'staff',
        meta: expect.objectContaining({ method: 'password', secondFactor: null }),
      }),
    ]);
  });

  it('records a wrong password against the account, and an unknown address against nobody', async () => {
    const user = staff.add(await newUser());

    await signIn({ password: 'not the password at all' }).catch(() => undefined);
    await signIn({ email: 'nobody@helpdock.com' }).catch(() => undefined);

    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in.failed',
        userId: user.id,
        actor: 'system',
        meta: { method: 'password', reason: 'wrong-password' },
      }),
      expect.objectContaining({
        action: 'auth.sign_in.failed',
        userId: null,
        meta: { method: 'password', reason: 'unknown-account' },
      }),
    ]);
    // The address that was typed is not written anywhere in the trail.
    expect(JSON.stringify(audit.entries)).not.toContain('nobody@helpdock.com');
  });

  it('records the lock when the last attempt is spent', async () => {
    const { user } = await withTotp();
    staff.add(user);
    const started = await signIn();
    if (started.kind !== 'totp-required') {
      throw new Error('expected a challenge');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service
        .verifyTotp({
          ip: '203.0.113.5',
          challengeId: started.challengeId,
          code: '000000',
          trustDevice: false,
          userAgent: undefined,
        })
        .catch(() => undefined);
    }

    expect(audit.actions()).toContain('auth.account.locked');
  });

  it('records a step-up the rate limit refused', async () => {
    const { user } = await withTotp();
    staff.add(user);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await service.regenerateRecoveryCodes(user.id, '000000').catch(() => undefined);
    }

    expect(audit.entries.at(-1)).toMatchObject({
      action: 'auth.step_up.refused',
      userId: user.id,
      meta: { reason: 'rate-limited' },
    });
  });
});

/** The token out of the fragment of a sign-in link. */
const tokenIn = (url: string): string =>
  new URLSearchParams(new URL(url, APP_URL).hash.slice(1)).get('token') ?? '';

const resetTokenIn = (text: string): string => {
  const line = text.split('\n').find((candidate) => candidate.includes('/sign-in/reset')) ?? '';
  return new URL(line, APP_URL).searchParams.get('token') ?? '';
};

describe('a passkey as the second factor (M18-03)', () => {
  const IP = '203.0.113.5';

  type Challenge = { challengeId: string; user: StaffUser; authenticator: SoftwareAuthenticator };

  /** Signs in with the password and holds the challenge a passkey (and, if asked, an app) can answer. */
  const start = async (
    options: { totp?: boolean; role?: StaffMembership['role']; email?: string } = {},
  ): Promise<Challenge & { secret: string | null }> => {
    const made = options.totp
      ? await withTotp({ email: options.email ?? 'lina@helpdock.com' })
      : { user: await newUser({ email: options.email ?? 'lina@helpdock.com' }), secret: null };
    staff.add(made.user, options.role ?? 'agent');
    const authenticator = new SoftwareAuthenticator();
    passkeyRows.rows.push(
      credentialRow(made.user.id, 'Key', authenticator.credentialId, authenticator.cosePublicKey),
    );
    const started = await signIn({ email: made.user.email });
    if (started.kind !== 'totp-required') throw new Error('expected a challenge');

    return {
      challengeId: started.challengeId,
      user: made.user,
      authenticator,
      secret: made.secret,
    };
  };

  const optionsFor = (challengeId: string) =>
    service.passkeySecondFactorOptions({ challengeId, ip: IP });

  const assertWith = async (
    authenticator: SoftwareAuthenticator,
    challengeId: string,
    overrides: { origin?: string; challenge?: string; signCount?: number } = {},
  ) => {
    const { ceremonyId, options } = await optionsFor(challengeId);
    return {
      ceremonyId,
      response: authenticator.assert(options as never, {
        origin: overrides.origin ?? APP_URL,
        ...(overrides.challenge === undefined ? {} : { challenge: overrides.challenge }),
        ...(overrides.signCount === undefined ? {} : { signCount: overrides.signCount }),
      }) as never,
    };
  };

  const verify = (
    challengeId: string,
    assertion: { ceremonyId: string; response: never },
    trustDevice = false,
  ) =>
    service.verifyPasskeySecondFactor({
      challengeId,
      ip: IP,
      ceremonyId: assertion.ceremonyId,
      response: assertion.response,
      trustDevice,
      userAgent: 'Firefox',
    });

  const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return (error as AuthFailure).auth;
    }
  };

  /**
   * The lock ends the challenge and refuses a fresh password sign-in: the
   * account stays locked for 15 minutes, and a stolen challenge id is worth nothing.
   */
  const expectLockedOut = async (challengeId: string, email: string): Promise<void> => {
    await expect(codeOf(optionsFor(challengeId))).resolves.toEqual({ code: 'challenge-expired' });
    await expect(signIn({ email })).rejects.toMatchObject({ auth: { code: 'totp-locked' } });
  };

  const failuresAudited = (): number =>
    audit.entries.filter((entry) => entry.action === 'auth.second_factor.failed').length;

  describe('the challenge', () => {
    it('offers a passkey-only account the passkey and no code', async () => {
      const user = staff.add(await newUser());
      passkeyCounts.set(user.id, 1);

      await expect(signIn()).resolves.toMatchObject({
        kind: 'totp-required',
        factors: { totp: false, passkey: true },
      });
    });

    it('offers an account with both, and one with an app alone as before', async () => {
      const both = await start({ totp: true });
      const appOnly = await withTotp({ email: 'sami@helpdock.com' });
      staff.add(appOnly.user);

      await expect(signIn({ email: both.user.email })).resolves.toMatchObject({
        factors: { totp: true, passkey: true },
      });
      await expect(signIn({ email: 'sami@helpdock.com' })).resolves.toMatchObject({
        factors: { totp: true, passkey: false },
      });
    });

    it('hides a passkey the install cannot use from an account that has an app, and keeps it for one that has not', async () => {
      const both = await start({ totp: true });
      const only = await start({ email: 'sami@helpdock.com' });
      rpIdPin.pinned = { rpId: 'old-desk.example.com', pinnedAt: new Date() };

      await expect(signIn({ email: both.user.email })).resolves.toMatchObject({
        factors: { totp: true, passkey: false },
      });
      await expect(signIn({ email: only.user.email })).resolves.toMatchObject({
        factors: { totp: false, passkey: true },
      });
    });

    it('is not skipped for a passkey-only account by a trusted browser that is not theirs', async () => {
      const { user } = await start();
      const trustedDeviceCookie = await new TrustedDeviceStore({
        redis: stub.asRedis(),
        masterKey: MASTER_KEY,
      }).trust(uuidv7());

      await expect(signIn({ email: user.email, trustedDeviceCookie })).resolves.toMatchObject({
        kind: 'totp-required',
      });
    });
  });

  describe('options', () => {
    it('names only the account’s credentials and spends no attempt', async () => {
      const { challengeId, authenticator } = await start();
      const stranger = new SoftwareAuthenticator();
      passkeyRows.rows.push(
        credentialRow(uuidv7(), 'Theirs', stranger.credentialId, stranger.cosePublicKey),
      );

      const { options } = await optionsFor(challengeId);
      for (let minted = 0; minted < 5; minted += 1) await optionsFor(challengeId);

      expect((options as { allowCredentials: { id: string }[] }).allowCredentials).toEqual([
        expect.objectContaining({
          id: Buffer.from(authenticator.credentialId).toString('base64url'),
        }),
      ]);
      const wrong = await assertWith(new SoftwareAuthenticator(), challengeId);
      await expect(codeOf(verify(challengeId, wrong))).resolves.toEqual({
        code: 'passkey-invalid',
        attemptsLeft: 2,
      });
    });

    it('is refused for an unknown challenge and for an enrolment challenge', async () => {
      await expect(codeOf(optionsFor('no-such-challenge'))).resolves.toEqual({
        code: 'challenge-expired',
      });

      staff.add(await newUser(), 'admin');
      const enrolling = await signIn();
      if (enrolling.kind !== 'second-factor-enrolment-required')
        throw new Error('expected enrolment');
      await expect(codeOf(optionsFor(enrolling.challengeId))).resolves.toEqual({
        code: 'challenge-expired',
      });
    });

    it('is refused for a challenge whose account holds no passkey', async () => {
      const { user } = await withTotp();
      staff.add(user);
      const started = await signIn();
      if (started.kind !== 'totp-required') throw new Error('expected a challenge');

      await expect(codeOf(optionsFor(started.challengeId))).resolves.toEqual({
        code: 'invalid-credentials',
      });
    });

    it('is refused once the account is locked', async () => {
      const { challengeId, user } = await start();
      for (let tries = 0; tries < 3; tries += 1) {
        await verify(challengeId, await assertWith(new SoftwareAuthenticator(), challengeId)).catch(
          () => undefined,
        );
      }

      await expectLockedOut(challengeId, user.email);
    });
  });

  describe('verify', () => {
    it('opens a session, records the use and spends the challenge', async () => {
      const { challengeId, user, authenticator } = await start();
      authenticator.signCount = 4;

      const spare = await assertWith(authenticator, challengeId);
      const { issued, trustedDeviceCookie } = await verify(
        challengeId,
        await assertWith(authenticator, challengeId),
      );

      expect(issued.session.user.email).toBe(user.email);
      expect(trustedDeviceCookie).toBeNull();
      expect(passkeyRows.rows[0]).toMatchObject({ signCount: 5, lastUsedAt: expect.any(Date) });
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'auth.sign_in.succeeded',
        meta: { method: 'password', secondFactor: 'passkey' },
      });
      await expect(codeOf(verify(challengeId, spare))).resolves.toEqual({
        code: 'challenge-expired',
      });
    });

    it('accepts an assertion without user verification: presence is enough after a first factor', async () => {
      const { challengeId, authenticator } = await start();
      const { ceremonyId, options } = await optionsFor(challengeId);
      const response = authenticator.assert(options as never, {
        origin: APP_URL,
        userVerified: false,
      }) as never;

      await expect(verify(challengeId, { ceremonyId, response })).resolves.toMatchObject({
        issued: expect.anything(),
      });
    });

    it('trusts the browser only when asked, whichever factor succeeded', async () => {
      const { challengeId, authenticator } = await start();

      const { trustedDeviceCookie } = await verify(
        challengeId,
        await assertWith(authenticator, challengeId),
        true,
      );

      expect(trustedDeviceCookie).toMatch(/^[0-9a-f-]+\..+\..+$/);
    });

    it('refuses a replayed assertion, and the replay costs an attempt', async () => {
      const first = await start();
      const assertion = await assertWith(first.authenticator, first.challengeId);
      await verify(first.challengeId, assertion);
      // The same person signs in again; the captured answer is offered to the new challenge.
      const again = await signIn({ email: first.user.email });
      if (again.kind !== 'totp-required') throw new Error('expected a challenge');

      await expect(codeOf(verify(again.challengeId, assertion))).resolves.toEqual({
        code: 'passkey-invalid',
        attemptsLeft: 2,
      });
      expect(audit.entries).toContainEqual(
        expect.objectContaining({
          action: 'auth.second_factor.failed',
          meta: { factor: 'passkey', reason: 'ceremony-gone' },
        }),
      );
    });

    it('refuses a ceremony minted for another challenge of the same person', async () => {
      const first = await start();
      const second = await signIn({ email: first.user.email });
      if (second.kind !== 'totp-required') throw new Error('expected a challenge');
      const assertion = await assertWith(first.authenticator, first.challengeId);

      await expect(codeOf(verify(second.challengeId, assertion))).resolves.toEqual({
        code: 'passkey-invalid',
        attemptsLeft: 2,
      });
    });

    it('refuses another person’s passkey, signed over this challenge’s options', async () => {
      const mine = await start();
      const theirs = new SoftwareAuthenticator();
      passkeyRows.rows.push(
        credentialRow(uuidv7(), 'Theirs', theirs.credentialId, theirs.cosePublicKey),
      );

      const assertion = await assertWith(theirs, mine.challengeId);

      await expect(codeOf(verify(mine.challengeId, assertion))).resolves.toEqual({
        code: 'passkey-invalid',
        attemptsLeft: 2,
      });
      expect(audit.entries).toContainEqual(
        expect.objectContaining({
          action: 'auth.second_factor.failed',
          meta: { factor: 'passkey', reason: 'wrong-user' },
        }),
      );
    });

    it('refuses a credential nobody holds', async () => {
      const { challengeId } = await start();

      await expect(
        codeOf(verify(challengeId, await assertWith(new SoftwareAuthenticator(), challengeId))),
      ).resolves.toEqual({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(audit.entries).toContainEqual(
        expect.objectContaining({ meta: { factor: 'passkey', reason: 'unknown-credential' } }),
      );
    });

    it.each([
      ['the wrong challenge', { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
      ['another origin', { origin: 'https://evil.example' }],
    ])('refuses an assertion made over %s', async (_label, overrides) => {
      const { challengeId, authenticator } = await start();

      await expect(
        codeOf(verify(challengeId, await assertWith(authenticator, challengeId, overrides))),
      ).resolves.toEqual({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(audit.entries).toContainEqual(
        expect.objectContaining({ meta: { factor: 'passkey', reason: 'bad-assertion' } }),
      );
    });

    it('refuses a counter that went backwards and audits it', async () => {
      const { challengeId, authenticator } = await start();
      const [held] = passkeyRows.rows;
      if (held) held.signCount = 9;

      await expect(
        codeOf(verify(challengeId, await assertWith(authenticator, challengeId, { signCount: 2 }))),
      ).resolves.toEqual({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(audit.actions()).toContain('auth.passkey.counter_regressed');
      expect(passkeyRows.rows[0]?.signCount).toBe(9);
    });

    it('will not take an enrolment challenge', async () => {
      staff.add(await newUser(), 'admin');
      const enrolling = await signIn();
      if (enrolling.kind !== 'second-factor-enrolment-required')
        throw new Error('expected enrolment');

      await expect(
        codeOf(
          service.verifyPasskeySecondFactor({
            challengeId: enrolling.challengeId,
            ip: IP,
            ceremonyId: 'x'.repeat(43),
            response: {} as never,
            trustDevice: false,
            userAgent: undefined,
          }),
        ),
      ).resolves.toEqual({ code: 'challenge-expired' });
    });
  });

  describe('the budget and the lock shared with codes', () => {
    it('counts two wrong codes and a wrong passkey as the third, then locks', async () => {
      const { challengeId, user } = await start({ totp: true });
      const wrongCode = () =>
        codeOf(
          service.verifyTotp({
            ip: IP,
            challengeId,
            code: '000000',
            trustDevice: false,
            userAgent: undefined,
          }),
        );

      await expect(wrongCode()).resolves.toEqual({ code: 'totp-mismatch', attemptsLeft: 2 });
      await expect(wrongCode()).resolves.toEqual({ code: 'totp-mismatch', attemptsLeft: 1 });
      const wrongPasskey = await assertWith(new SoftwareAuthenticator(), challengeId);
      await expect(codeOf(verify(challengeId, wrongPasskey))).resolves.toEqual({
        code: 'totp-locked',
      });

      await expectLockedOut(challengeId, user.email);
    });

    it('lets the third attempt be a correct passkey after two wrong codes', async () => {
      const { challengeId, authenticator } = await start({ totp: true });
      for (let tries = 0; tries < 2; tries += 1) {
        await service
          .verifyTotp({
            ip: IP,
            challengeId,
            code: '000000',
            trustDevice: false,
            userAgent: undefined,
          })
          .catch(() => undefined);
      }

      await expect(
        verify(challengeId, await assertWith(authenticator, challengeId)),
      ).resolves.toMatchObject({ issued: expect.anything() });
    });

    it('counts wrong passkeys against a recovery code too, and the lock holds for both', async () => {
      const { challengeId, user } = await start({ totp: true });
      for (let tries = 0; tries < 3; tries += 1) {
        await verify(challengeId, await assertWith(new SoftwareAuthenticator(), challengeId)).catch(
          () => undefined,
        );
      }

      await expect(
        codeOf(
          service.useRecoveryCode({ ip: IP, challengeId, code: 'AAAA-AAAA', userAgent: undefined }),
        ),
      ).resolves.toEqual({ code: 'challenge-expired' });
      await expectLockedOut(challengeId, user.email);
    });

    it('evaluates no more than three guesses in a parallel burst of codes and passkeys', async () => {
      const { challengeId, user } = await start({ totp: true });
      const wrong = await Promise.all(
        Array.from({ length: 4 }, () => assertWith(new SoftwareAuthenticator(), challengeId)),
      );

      const results = await Promise.allSettled([
        ...wrong.map((assertion) => verify(challengeId, assertion)),
        ...Array.from({ length: 4 }, () =>
          service.verifyTotp({
            ip: IP,
            challengeId,
            code: '000000',
            trustDevice: false,
            userAgent: undefined,
          }),
        ),
      ]);

      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(failuresAudited()).toBe(3);
      await expectLockedOut(challengeId, user.email);
    });

    it('does not let a correct passkey open a session once the lock has landed', async () => {
      const { challengeId, authenticator, user } = await start();
      const ready = await assertWith(authenticator, challengeId);
      for (let tries = 0; tries < 3; tries += 1) {
        await verify(challengeId, await assertWith(new SoftwareAuthenticator(), challengeId)).catch(
          () => undefined,
        );
      }

      await expect(codeOf(verify(challengeId, ready))).resolves.toEqual({
        code: 'challenge-expired',
      });
      await expectLockedOut(challengeId, user.email);
    });

    it('does not open a session when the lock lands while the assertion is being checked', async () => {
      const { challengeId, authenticator, user } = await start();
      const ready = await assertWith(authenticator, challengeId);
      const lookUp = passkeyRows.byCredentialId;
      passkeyRows.byCredentialId = async (credentialId) => {
        await stub.asRedis().set(totpLockKey(user.id), '1');
        return lookUp(credentialId);
      };

      await expect(codeOf(verify(challengeId, ready))).resolves.toEqual({ code: 'totp-locked' });
      expect(audit.actions()).not.toContain('auth.sign_in.succeeded');
      expect(passkeyRows.rows[0]?.lastUsedAt).toBeNull();
    });
  });

  describe('enrolment from a challenge', () => {
    const enrolment = async (): Promise<{ challengeId: string; user: StaffUser }> => {
      const user = staff.add(await newUser(), 'admin');
      const started = await signIn();
      if (started.kind !== 'second-factor-enrolment-required')
        throw new Error('expected enrolment');
      return { challengeId: started.challengeId, user };
    };

    const register = async (
      challengeId: string,
      authenticator: SoftwareAuthenticator,
      overrides: { origin?: string } = {},
    ) => {
      const { ceremonyId, options } = await service.startPasskeyEnrolment(challengeId);
      return {
        ceremonyId,
        response: authenticator.register(options as never, {
          origin: overrides.origin ?? APP_URL,
        }) as never,
      };
    };

    const complete = (
      challengeId: string,
      registration: { ceremonyId: string; response: never },
      name = 'MacBook',
    ) =>
      service.completePasskeyEnrolment({
        challengeId,
        ip: IP,
        ceremonyId: registration.ceremonyId,
        response: registration.response,
        name,
        userAgent: 'Firefox',
      });

    it('stores the passkey, draws the recovery codes and opens the session', async () => {
      const { challengeId, user } = await enrolment();

      const { recoveryCodes, issued } = await complete(
        challengeId,
        await register(challengeId, new SoftwareAuthenticator()),
      );

      expect(recoveryCodes).toHaveLength(10);
      expect(issued.session.user.email).toBe(user.email);
      expect(passkeyRows.rows).toMatchObject([{ userId: user.id, name: 'MacBook' }]);
      expect(staff.users.get(user.id)?.recoveryCodesHashed).toHaveLength(10);
      expect(audit.actions()).toEqual(['auth.passkey.added', 'auth.sign_in.succeeded']);
      expect(audit.entries[1]?.meta).toMatchObject({ method: 'password', secondFactor: 'passkey' });
      expect(mail.sent.map((message) => message.kind)).toEqual(['securityChange']);
      expect(mail.sent[0]?.values).toMatchObject({ change: 'passkeyAdded', passkey: 'MacBook' });
      expect(rpIdPin.pinned?.rpId).toBe('support.example.com');
    });

    it('spends the challenge: it cannot enrol twice', async () => {
      const { challengeId } = await enrolment();
      const registration = await register(challengeId, new SoftwareAuthenticator());
      await complete(challengeId, registration);

      await expect(codeOf(complete(challengeId, registration))).resolves.toEqual({
        code: 'challenge-expired',
      });
      expect(passkeyRows.rows).toHaveLength(1);
    });

    it('charges a registration that does not verify an attempt, and stores nothing', async () => {
      const { challengeId } = await enrolment();

      await expect(
        codeOf(
          complete(
            challengeId,
            await register(challengeId, new SoftwareAuthenticator(), {
              origin: 'https://evil.example',
            }),
          ),
        ),
      ).resolves.toEqual({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(passkeyRows.rows).toEqual([]);
    });

    it('refuses a ceremony begun for another challenge, as a replay would be', async () => {
      const first = await enrolment();
      const second = await signIn();
      if (second.kind !== 'second-factor-enrolment-required') throw new Error('expected enrolment');
      const registration = await register(first.challengeId, new SoftwareAuthenticator());

      await expect(codeOf(complete(second.challengeId, registration))).resolves.toEqual({
        code: 'passkey-invalid',
        attemptsLeft: 2,
      });
    });

    it('locks after three failures shared with codes', async () => {
      const { challengeId } = await enrolment();
      await service.startEnrolment(challengeId);
      await service
        .completeEnrolment({ ip: IP, challengeId, code: '000000', userAgent: undefined })
        .catch(() => undefined);
      const bad = await register(challengeId, new SoftwareAuthenticator(), {
        origin: 'https://evil.example',
      });
      await complete(challengeId, bad).catch(() => undefined);

      await expect(
        codeOf(
          complete(
            challengeId,
            await register(challengeId, new SoftwareAuthenticator(), {
              origin: 'https://evil.example',
            }),
          ),
        ),
      ).resolves.toEqual({ code: 'totp-locked' });
    });

    it('will not take a second-factor challenge for an enrolment', async () => {
      const { challengeId } = await start();

      await expect(codeOf(service.startPasskeyEnrolment(challengeId))).resolves.toEqual({
        code: 'challenge-expired',
      });
    });

    it('refuses a stale enrolment challenge once the account has a second factor', async () => {
      const { challengeId, user } = await enrolment();
      const registration = await register(challengeId, new SoftwareAuthenticator());
      passkeyCounts.set(user.id, 1);

      await expect(codeOf(complete(challengeId, registration))).resolves.toEqual({
        code: 'challenge-expired',
      });
      expect(passkeyRows.rows).toEqual([]);
    });

    it('refuses the eleventh passkey', async () => {
      const { challengeId, user } = await enrolment();
      for (let held = 0; held < 10; held += 1) {
        const key = new SoftwareAuthenticator();
        passkeyRows.rows.push(
          credentialRow(user.id, `Key ${held}`, key.credentialId, key.cosePublicKey),
        );
      }

      await expect(codeOf(service.startPasskeyEnrolment(challengeId))).resolves.toEqual({
        code: 'passkey-limit',
      });
    });
  });

  describe('a stale enrolment challenge (it must not replace a factor set since)', () => {
    const IPV = '203.0.113.9';
    const staleChallenge = async (): Promise<{ challengeId: string; user: StaffUser }> => {
      const user = staff.add(await newUser(), 'admin');
      const started = await signIn();
      if (started.kind !== 'second-factor-enrolment-required')
        throw new Error('expected enrolment');
      return { challengeId: started.challengeId, user };
    };

    it('does not stage over an authenticator the account turned on meanwhile', async () => {
      const { challengeId, user } = await staleChallenge();
      const secret = newTotpSecret();
      staff.users.set(user.id, {
        ...user,
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(
          secret,
          createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }),
        ),
      });
      const before = staff.users.get(user.id)?.totpSecretEncrypted;

      await expect(codeOf(service.startEnrolment(challengeId))).resolves.toEqual({
        code: 'challenge-expired',
      });

      expect(staff.users.get(user.id)).toMatchObject({
        totpEnabled: true,
        totpSecretEncrypted: before,
      });
    });

    it('does not stage beside a passkey the account added meanwhile', async () => {
      const { challengeId, user } = await staleChallenge();
      passkeyCounts.set(user.id, 1);

      await expect(codeOf(service.startEnrolment(challengeId))).resolves.toEqual({
        code: 'challenge-expired',
      });
      expect(staff.users.get(user.id)?.totpSecretEncrypted).toBeNull();
    });

    it('does not turn a factor on when the code is right but the account got one first', async () => {
      const { challengeId, user } = await staleChallenge();
      const { secret } = await service.startEnrolment(challengeId);
      passkeyCounts.set(user.id, 1);

      await expect(
        codeOf(
          service.completeEnrolment({
            ip: IPV,
            challengeId,
            code: await generate({ secret }),
            userAgent: undefined,
          }),
        ),
      ).resolves.toEqual({ code: 'challenge-expired' });

      expect(staff.users.get(user.id)?.totpEnabled).toBe(false);
      expect(audit.actions()).not.toContain('auth.sign_in.succeeded');
    });

    it('takes the account lock before it checks, as passkey add and remove do', async () => {
      const { challengeId } = await staleChallenge();
      const { secret } = await service.startEnrolment(challengeId);
      passkeyRows.calls.length = 0;

      await service.completeEnrolment({
        ip: IPV,
        challengeId,
        code: await generate({ secret }),
        userAgent: undefined,
      });

      expect(passkeyRows.calls.slice(0, 2)).toEqual(['lock', 'count']);
    });

    it('does not let a bare session replace the authenticator that is on', async () => {
      const { user, secret } = await withTotp();
      staff.add(user, 'admin');
      const before = staff.users.get(user.id)?.totpSecretEncrypted;

      await expect(codeOf(service.enrolTotp(user.id))).resolves.toEqual({
        code: 'totp-already-enabled',
      });

      expect(staff.users.get(user.id)).toMatchObject({
        totpEnabled: true,
        totpSecretEncrypted: before,
      });
      expect(secret).toBeTruthy();
    });

    it('still lets a session stage the first authenticator, or one beside a passkey', async () => {
      const user = staff.add(await newUser());
      passkeyCounts.set(user.id, 1);

      await expect(service.enrolTotp(user.id)).resolves.toMatchObject({
        secret: expect.any(String),
      });
    });
  });

  describe('under SSO enforcement', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const asSso = async (): Promise<{
      challengeId: string;
      authenticator: SoftwareAuthenticator;
    }> => {
      const user = staff.add(await newUser(), 'admin');
      const authenticator = new SoftwareAuthenticator();
      passkeyRows.rows.push(
        credentialRow(user.id, 'Key', authenticator.credentialId, authenticator.cosePublicKey),
      );
      const challengeId = await new TotpChallengeStore(stub.asRedis()).create({
        userId: user.id,
        kind: 'second-factor',
        firstFactor: 'sso',
        ssoConnectionId: uuidv7(),
      });
      vi.spyOn(SsoIdentityService.prototype, 'assertLinked').mockResolvedValue(undefined);
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      return { challengeId, authenticator };
    };

    it('lets a passkey answer the second factor after an SSO assertion that does not vouch for MFA', async () => {
      const { challengeId, authenticator } = await asSso();

      const { issued } = await verify(challengeId, await assertWith(authenticator, challengeId));

      expect(issued.session.user.email).toBe('lina@helpdock.com');
      expect(audit.entries.at(-1)?.meta).toMatchObject({ method: 'sso', secondFactor: 'passkey' });
    });

    it('offers the app and the passkey on the challenge an SSO assertion leaves', async () => {
      const made = await withTotp();
      const user = staff.add(made.user, 'admin');
      passkeyCounts.set(user.id, 1);
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      vi.spyOn(SsoIdentityService.prototype, 'signIn').mockResolvedValue({
        user,
        idpEnforcesMfa: false,
      } as never);

      await expect(
        service.completeSso(
          {
            connectionId: uuidv7(),
            subject: 'staff-1',
            email: user.email,
            emailVerified: true,
            groups: [],
          },
          undefined,
        ),
      ).resolves.toMatchObject({
        kind: 'totp-required',
        factors: { totp: true, passkey: true },
      });
    });

    it('lets a recovery code finish an SSO sign-in under enforcement, and spends it (#387)', async () => {
      const user = staff.add(
        await newUser({
          recoveryCodesHashed: await hashRecoveryCodes(['RC-2MDV-KDNP'], hasher),
        }),
        'admin',
      );
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      vi.spyOn(SsoIdentityService.prototype, 'assertLinked').mockResolvedValue(undefined);
      const challengeId = await new TotpChallengeStore(stub.asRedis()).create({
        userId: user.id,
        kind: 'second-factor',
        firstFactor: 'sso',
        ssoConnectionId: uuidv7(),
      });

      await expect(
        service.useRecoveryCode({
          ip: IP,
          challengeId,
          code: 'rc-2mdv-kdnp',
          userAgent: undefined,
        }),
      ).resolves.toMatchObject({ session: { user: { email: user.email } } });

      expect(staff.users.get(user.id)?.recoveryCodesHashed).toEqual([]);
      expect(audit.entries.at(-1)?.meta).toMatchObject({
        method: 'sso',
        secondFactor: 'recovery-code',
      });
    });

    it('offers the app and the passkey after a break-glass password', async () => {
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      const local = await start({ totp: true });

      await expect(signIn({ email: local.user.email })).resolves.toMatchObject({
        factors: { totp: true, passkey: true },
      });
    });

    it('opens the break-glass session with a passkey that carries user verification', async () => {
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      const { challengeId, authenticator } = await start();

      await expect(
        verify(challengeId, await assertWith(authenticator, challengeId)),
      ).resolves.toMatchObject({ issued: expect.anything() });
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'auth.sign_in.succeeded',
        meta: { method: 'password', secondFactor: 'passkey' },
      });
    });

    it('refuses a break-glass assertion without user verification and charges an attempt', async () => {
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      const { challengeId, authenticator } = await start();
      const { ceremonyId, options } = await optionsFor(challengeId);
      const response = authenticator.assert(options as never, {
        origin: APP_URL,
        userVerified: false,
      }) as never;

      await expect(codeOf(verify(challengeId, { ceremonyId, response }))).resolves.toEqual({
        code: 'passkey-invalid',
        attemptsLeft: 2,
      });
    });

    it('refuses a ceremony minted before enforcement came on, and a fresh one then works', async () => {
      const { challengeId, authenticator } = await start();
      const early = await assertWith(authenticator, challengeId);
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);

      await expect(codeOf(verify(challengeId, early))).resolves.toMatchObject({
        code: 'passkey-invalid',
      });
      await expect(
        verify(challengeId, await assertWith(authenticator, challengeId)),
      ).resolves.toMatchObject({ issued: expect.anything() });
    });

    it('refuses a local first factor that is not a break-glass admin before it mints a ceremony or costs an attempt', async () => {
      const { challengeId } = await start();
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      vi.spyOn(SsoSignInPolicy.prototype, 'assertLocal').mockRejectedValue(
        new AuthFailureClass('sso-required'),
      );

      await expect(codeOf(optionsFor(challengeId))).resolves.toEqual({ code: 'sso-required' });
      await expect(
        codeOf(
          service.verifyPasskeySecondFactor({
            challengeId,
            ip: IP,
            ceremonyId: 'A'.repeat(43),
            response: {} as never,
            trustDevice: false,
            userAgent: undefined,
          }),
        ),
      ).resolves.toEqual({ code: 'sso-required' });
    });

    it('never lets a recovery code finish a break-glass sign-in', async () => {
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);
      const { challengeId } = await start();

      await expect(
        codeOf(
          service.useRecoveryCode({
            challengeId,
            ip: IP,
            code: 'abcde-fghij',
            userAgent: undefined,
          }),
        ),
      ).resolves.toEqual({ code: 'sso-required' });
    });
  });

  describe('having a factor', () => {
    it('counts a passkey as a second factor', async () => {
      const user = await newUser();
      staff.add(user);
      await expect(service.hasSecondFactor(user)).resolves.toBe(false);

      passkeyCounts.set(user.id, 1);

      await expect(service.hasSecondFactor(user)).resolves.toBe(true);
      await expect(service.hasSecondFactor({ ...user, totpEnabled: true })).resolves.toBe(true);
    });

    it('lets an Admin turn the app off while a passkey remains, keeping the recovery codes, under the account lock', async () => {
      const { user, secret } = await withTotp({ recoveryCodesHashed: ['hash-1', 'hash-2'] });
      staff.add(user, 'admin');
      passkeyCounts.set(user.id, 1);

      await service.disableTotp(user.id, await generate({ secret }), {} as DbTransaction);

      expect(staff.users.get(user.id)).toMatchObject({
        totpEnabled: false,
        recoveryCodesHashed: ['hash-1', 'hash-2'],
      });
      expect(passkeyRows.calls.slice(0, 2)).toEqual(['lock', 'count']);
    });

    it('still refuses an Admin whose app is the only factor, and takes the lock first', async () => {
      const { user, secret } = await withTotp();
      staff.add(user, 'admin');

      await expect(
        service.disableTotp(user.id, await generate({ secret }), {} as DbTransaction),
      ).rejects.toMatchObject({ auth: { code: 'unavailable' } });
      expect(passkeyRows.calls.slice(0, 2)).toEqual(['lock', 'count']);
      expect(staff.users.get(user.id)?.totpEnabled).toBe(true);
    });

    it('forgets the recovery codes when the app was the last factor of an account that may go without', async () => {
      const { user, secret } = await withTotp({ recoveryCodesHashed: ['hash-1'] });
      staff.add(user, 'agent');

      await service.disableTotp(user.id, await generate({ secret }), {} as DbTransaction);

      expect(staff.users.get(user.id)?.recoveryCodesHashed).toEqual([]);
    });

    it('does not draw new recovery codes for an app added beside a passkey', async () => {
      const user = staff.add(await newUser({ recoveryCodesHashed: ['hash-1'] }));
      passkeyCounts.set(user.id, 1);
      const staged = await service.enrolTotp(user.id);

      const { recoveryCodes } = await service.confirmTotp(
        user.id,
        await generate({ secret: staged.secret }),
        {} as DbTransaction,
      );

      expect(recoveryCodes).toEqual([]);
      expect(staff.users.get(user.id)?.recoveryCodesHashed).toEqual(['hash-1']);
      expect(passkeyRows.calls.slice(0, 1)).toEqual(['lock']);
    });

    it('takes the account lock before it redraws with a code, as turning the app off does', async () => {
      const { user, secret } = await withTotp();
      staff.add(user, 'admin');

      await service.regenerateRecoveryCodes(
        user.id,
        await generate({ secret }),
        {} as DbTransaction,
      );

      expect(passkeyRows.calls[0]).toBe('lock');
    });

    it('redraws the codes after a passkey assertion, and only for an account with a factor', async () => {
      const user = staff.add(await newUser());
      await expect(
        service.regenerateRecoveryCodesAfterPasskey(user.id, {} as DbTransaction),
      ).rejects.toMatchObject({ auth: { code: 'unavailable' } });

      passkeyCounts.set(user.id, 1);
      const { recoveryCodes } = await service.regenerateRecoveryCodesAfterPasskey(
        user.id,
        {} as DbTransaction,
      );

      expect(recoveryCodes).toHaveLength(10);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'auth.recovery_codes.regenerated',
        meta: { proof: 'passkey' },
      });
    });
  });
});

describe('passwordless sign-in with a passkey (M18-04)', () => {
  const IP = '203.0.113.9';

  // Earlier suites leave a spy on the SSO policy; this one starts from the real one.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const holder = async (
    options: {
      authenticator?: SoftwareAuthenticator;
      user?: Partial<StaffUser>;
      role?: StaffMembership['role'] | null;
    } = {},
  ) => {
    const user = await newUser(options.user);
    if (options.role !== null) staff.add(user, options.role ?? 'agent');
    else staff.users.set(user.id, user);
    const authenticator = options.authenticator ?? new SoftwareAuthenticator();
    passkeyRows.rows.push(
      credentialRow(user.id, 'Key', authenticator.credentialId, authenticator.cosePublicKey),
    );
    return { user, authenticator };
  };

  const assertionFrom = async (
    authenticator: SoftwareAuthenticator,
    overrides: Partial<Parameters<SoftwareAuthenticator['assert']>[1]> = {},
    ip = IP,
  ) => {
    const { ceremonyId, options } = await service.passkeySignInOptions({ ip });
    return {
      ceremonyId,
      response: authenticator.assert(options as never, {
        origin: APP_URL,
        ...overrides,
      }) as never,
    };
  };

  const verify = (assertion: { ceremonyId: string; response: never }, ip = IP) =>
    service.verifyPasskeySignIn({
      ip,
      ceremonyId: assertion.ceremonyId,
      response: assertion.response,
      userAgent: 'Firefox',
    });

  const authOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return (error as AuthFailure).auth;
    }
  };

  const failureReasons = () =>
    audit.entries
      .filter((entry) => entry.action === 'auth.sign_in.failed')
      .map((entry) => entry.meta?.reason);

  it('mints options that name nobody and give the shared budget its slot back', async () => {
    const { options } = await service.passkeySignInOptions({ ip: IP });

    expect(options).toMatchObject({ userVerification: 'required', rpId: 'support.example.com' });
    expect(options.allowCredentials ?? []).toEqual([]);
  });

  it.each([['passkeys-unavailable'], ['passkeys-rp-changed']] as const)(
    'gives the budget slot back when the options cannot be minted (%s)',
    async (code) => {
      vi.spyOn(WebAuthnService.prototype, 'authenticationOptions').mockRejectedValue(
        new AuthFailureClass(code),
      );
      const refund = vi.spyOn(RateLimiter.prototype, 'refundSignInIp');

      await expect(authOf(service.passkeySignInOptions({ ip: IP }))).resolves.toEqual({ code });

      expect(refund).toHaveBeenCalledOnce();
    },
  );

  it('opens a session with method passkey and the user-verified factor, and records the use', async () => {
    const { user, authenticator } = await holder();

    const issued = await verify(await assertionFrom(authenticator));

    expect(issued.session.user.id).toBe(user.id);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'auth.sign_in.succeeded',
      meta: { method: 'passkey', secondFactor: 'passkey-uv' },
    });
    expect(passkeyRows.rows[0]?.lastUsedAt).not.toBeNull();
  });

  it('asks for no second factor of an account that has an authenticator app', async () => {
    const { user, authenticator } = await holder({
      user: { totpEnabled: true, totpSecretEncrypted: 'sealed' },
    });

    const issued = await verify(await assertionFrom(authenticator));

    expect(issued.session.user.id).toBe(user.id);
  });

  describe('refusals', () => {
    const refused = { code: 'invalid-credentials' };

    it('answers an unknown credential like any other failure', async () => {
      await expect(
        authOf(verify(await assertionFrom(new SoftwareAuthenticator()))),
      ).resolves.toEqual(refused);
      expect(failureReasons()).toEqual(['unknown-credential']);
    });

    it('refuses an assertion made without user verification', async () => {
      const { authenticator } = await holder({
        authenticator: new SoftwareAuthenticator({ userVerified: false }),
      });

      await expect(authOf(verify(await assertionFrom(authenticator)))).resolves.toEqual(refused);
      expect(failureReasons()).toEqual(['bad-assertion']);
      expect(passkeyRows.rows[0]?.lastUsedAt).toBeNull();
    });

    it('refuses a regressed counter, audits it and leaves the stored counter alone', async () => {
      const { authenticator } = await holder({
        authenticator: new SoftwareAuthenticator({ signCount: 5 }),
      });
      Object.assign(passkeyRows.rows[0] ?? {}, { signCount: 40 });

      await expect(authOf(verify(await assertionFrom(authenticator)))).resolves.toEqual(refused);
      expect(passkeyRows.rows[0]?.signCount).toBe(40);
      expect(audit.entries.map((entry) => entry.action)).toContain(
        'auth.passkey.counter_regressed',
      );
    });

    it('refuses a replayed answer', async () => {
      const { authenticator } = await holder();
      const assertion = await assertionFrom(authenticator);
      await verify(assertion);

      await expect(authOf(verify(assertion))).resolves.toEqual(refused);
      expect(failureReasons()).toEqual(['ceremony-gone']);
    });

    it('refuses a deactivated person with the same answer', async () => {
      const { authenticator } = await holder({
        user: { status: 'deactivated', deactivatedAt: new Date() },
      });

      await expect(authOf(verify(await assertionFrom(authenticator)))).resolves.toEqual(refused);
      expect(failureReasons()).toEqual(['unusable-account']);
      expect(passkeyRows.rows[0]?.lastUsedAt).toBeNull();
    });

    it('refuses an account with no role in any brand, with the same answer, and records no use', async () => {
      const { authenticator } = await holder({ role: null });

      await expect(authOf(verify(await assertionFrom(authenticator)))).resolves.toEqual(refused);
      expect(failureReasons()).toEqual(['no-brand-role']);
      expect(passkeyRows.rows[0]?.lastUsedAt).toBeNull();
    });

    it('refuses an assertion that reports another user handle', async () => {
      const { authenticator } = await holder();

      await expect(
        authOf(
          verify(
            await assertionFrom(authenticator, {
              userHandle: Buffer.alloc(32, 1).toString('base64url'),
            }),
          ),
        ),
      ).resolves.toEqual(refused);
      expect(failureReasons()).toEqual(['user-handle-mismatch']);
    });
  });

  describe('under SSO enforcement', () => {
    it('refuses the options and the assertion before anything is spent', async () => {
      const { authenticator } = await holder();
      const assertion = await assertionFrom(authenticator);
      vi.spyOn(SsoSignInPolicy.prototype, 'enforced').mockResolvedValue(true);

      await expect(authOf(service.passkeySignInOptions({ ip: IP }))).resolves.toEqual({
        code: 'sso-required',
      });
      await expect(authOf(verify(assertion))).resolves.toEqual({ code: 'sso-required' });
      expect(passkeyRows.rows[0]?.lastUsedAt).toBeNull();
    });
  });

  describe('the budget', () => {
    it('is the password form’s: failures from one IP run it out for both', async () => {
      const { authenticator } = await holder();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await authOf(verify(await assertionFrom(new SoftwareAuthenticator())));
      }

      await expect(
        authOf(verify(await assertionFrom(authenticator).catch(() => ({}) as never))),
      ).resolves.toMatchObject({ code: 'rate-limited' });
      await expect(signIn({ ip: IP })).rejects.toMatchObject({ auth: { code: 'rate-limited' } });
    });

    it('keeps another IP’s budget apart', async () => {
      const { authenticator } = await holder();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await authOf(verify(await assertionFrom(new SoftwareAuthenticator())));
      }

      const issued = await verify(
        await assertionFrom(authenticator, {}, '198.51.100.7'),
        '198.51.100.7',
      );

      expect(issued.session.user.email).toBe('lina@helpdock.com');
    });
  });
});

describe('replacing the authenticator app (#373)', () => {
  /** An account that must have a second factor and holds only the app. */
  const requiredAccount = async (): Promise<{ userId: string; secret: string }> => {
    const { user, secret } = await withTotp();
    staff.add(user, 'admin');

    return { userId: user.id, secret };
  };

  // The routes always hold a transaction, and the account-row lock is taken
  // only when one is passed: without it these tests would not run that line.
  const tx = (): DbTransaction => requestTx;

  const start = (userId: string, proof: Parameters<AuthService['startTotpRotation']>[0]['proof']) =>
    service.startTotpRotation({ userId, proof, tx: tx() });

  const confirm = (userId: string, rotationId: string, code: string): Promise<void> =>
    service.confirmTotpRotation({ userId, rotationId, code, tx: tx() });

  const liveSecretOf = (userId: string): string | null => {
    const encrypted = staff.users.get(userId)?.totpSecretEncrypted ?? null;
    return encrypted === null
      ? null
      : decryptSecret(encrypted, createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }));
  };

  /** A code from the step after this one: the used-step record refuses a second code on one step. */
  const nextCode = (secret: string): Promise<string> =>
    generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });

  const rotatedAudited = (): boolean =>
    audit.entries.some((entry) => entry.action === 'auth.second_factor.rotated');

  describe('the step-up', () => {
    it('takes a live code from the current app and stages a fresh secret', async () => {
      const { userId, secret } = await requiredAccount();

      const staged = await start(userId, { code: await generate({ secret }) });

      expect(staged.rotationId).toBeTruthy();
      expect(staged.secret).not.toBe(secret);
      expect(staged.uri).toContain('otpauth://');
      // Nothing has changed yet: no swap, no email, no audit row.
      expect(liveSecretOf(userId)).toBe(secret);
      expect(mail.sent).toHaveLength(0);
      expect(rotatedAudited()).toBe(false);
    });

    it('takes a recovery code alone, and spends it', async () => {
      const { userId } = await requiredAccount();
      const user = staff.users.get(userId);
      if (user === undefined) throw new Error('no user');
      const codes = ['RC-4KQ2-9XMT', 'RC-8ZP3-2WVN'];
      user.recoveryCodesHashed = await hashRecoveryCodes(codes, hasher);

      await expect(start(userId, { recoveryCode: codes[0] as string })).resolves.toMatchObject({
        rotationId: expect.any(String),
      });
      expect(staff.users.get(userId)?.recoveryCodesHashed).toHaveLength(codes.length - 1);
      expect(audit.actions()).toContain('auth.recovery_code.used');
    });

    it('reads the SSO policy inside the request transaction, never from the pool', async () => {
      const { userId } = await requiredAccount();
      const user = staff.users.get(userId);
      if (user === undefined) throw new Error('no user');
      user.recoveryCodesHashed = await hashRecoveryCodes(['RC-4KQ2-9XMT'], hasher);
      poolTransactions = 0;

      await start(userId, { recoveryCode: 'RC-4KQ2-9XMT' });

      expect(poolTransactions).toBe(0);
    });

    describe('under SSO enforcement', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      const seedCodes = async (userId: string): Promise<void> => {
        const user = staff.users.get(userId);
        if (user === undefined) throw new Error('no user');
        user.recoveryCodesHashed = await hashRecoveryCodes(['RC-4KQ2-9XMT'], hasher);
      };

      it('refuses a recovery code, bare or with the password, to a barred account, spending nothing', async () => {
        const { userId } = await requiredAccount();
        await seedCodes(userId);
        vi.spyOn(SsoSignInPolicy.prototype, 'recoveryCodeBarred').mockResolvedValue(true);

        await expect(start(userId, { recoveryCode: 'RC-4KQ2-9XMT' })).rejects.toMatchObject({
          auth: { code: 'recovery-code-not-allowed' },
        });
        await expect(
          start(userId, { currentPassword: PASSWORD, recoveryCode: 'RC-4KQ2-9XMT' }),
        ).rejects.toMatchObject({ auth: { code: 'recovery-code-not-allowed' } });
        expect(staff.users.get(userId)?.recoveryCodesHashed).toHaveLength(1);
        expect(audit.actions()).not.toContain('auth.step_up.refused');
      });

      it('still takes the current app code from a barred account', async () => {
        const { userId, secret } = await requiredAccount();
        vi.spyOn(SsoSignInPolicy.prototype, 'recoveryCodeBarred').mockResolvedValue(true);

        await expect(start(userId, { code: await generate({ secret }) })).resolves.toMatchObject({
          rotationId: expect.any(String),
        });
      });

      it('takes a recovery code from an account that is not barred', async () => {
        const { userId } = await requiredAccount();
        await seedCodes(userId);
        vi.spyOn(SsoSignInPolicy.prototype, 'recoveryCodeBarred').mockResolvedValue(false);

        await expect(start(userId, { recoveryCode: 'RC-4KQ2-9XMT' })).resolves.toMatchObject({
          rotationId: expect.any(String),
        });
      });
    });

    it('takes the password with a recovery code, and refuses with either half wrong', async () => {
      const { userId } = await requiredAccount();
      const codes = ['RC-4KQ2-9XMT', 'RC-8ZP3-2WVN'];
      // Through the map on purpose: replaceRecoveryCodes swaps the row object,
      // so a reference held here would go stale.
      const seed = async (): Promise<void> => {
        const user = staff.users.get(userId);
        if (user === undefined) throw new Error('no user');
        user.recoveryCodesHashed = await hashRecoveryCodes(codes, hasher);
      };
      await seed();

      await expect(
        start(userId, { currentPassword: PASSWORD, recoveryCode: codes[1] as string }),
      ).resolves.toMatchObject({ rotationId: expect.any(String) });
      expect(staff.users.get(userId)?.recoveryCodesHashed).toHaveLength(codes.length - 1);

      // The wrong password refuses the whole proof and spends no recovery code.
      await seed();
      await expect(
        start(userId, { currentPassword: 'not the password', recoveryCode: codes[0] as string }),
      ).rejects.toMatchObject({ auth: { code: 'invalid-credentials' } });
      expect(staff.users.get(userId)?.recoveryCodesHashed).toHaveLength(codes.length);
    });

    it('takes an assertion from a held passkey, verified by PasskeyService before anything is staged', async () => {
      const { userId } = await requiredAccount();
      const authenticator = new SoftwareAuthenticator();
      passkeyRows.rows.push(
        credentialRow(userId, 'Key', authenticator.credentialId, authenticator.cosePublicKey),
      );
      // The passkey step-up is PasskeyService's (M18-02); the account service
      // proves it there and then asks for the staging, which is what runs here.
      const passkeys = new PasskeyService({
        auth: service,
        webauthn,
        passkeys: passkeyRows as unknown as PasskeyRepository,
        limiter,
        signingKeys,
        ssoPolicy: new SsoSignInPolicy({
          db: {} as Db,
          settings,
          keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }),
        }),
        logger: silentLogger(),
      });
      const session = { userId, familyId: 'fam-1', tx: {} as DbTransaction };

      const { ceremonyId, options } = await webauthn.authenticationOptions({
        purpose: 'step-up',
        binding: { userId, familyId: session.familyId },
        allow: await passkeyRows.ofUser(userId),
      });
      const response = authenticator.assert(options as never, { origin: APP_URL }) as never;
      await passkeys.confirmStepUp(session, { ceremonyId, response });

      await expect(service.stageTotpRotation(userId)).resolves.toMatchObject({
        rotationId: expect.any(String),
      });
      // The ceremony is spent: the same assertion cannot prove a second change.
      await expect(passkeys.confirmStepUp(session, { ceremonyId, response })).rejects.toMatchObject(
        { auth: { code: 'challenge-expired' } },
      );
    });

    it('refuses an account with no app before any proof is spent', async () => {
      const user = staff.add(await newUser());

      await expect(start(user.id, { code: '000000' })).rejects.toMatchObject({
        auth: { code: 'totp-not-enabled' },
      });
      expect(audit.actions()).not.toContain('auth.step_up.refused');
    });

    it('charges a wrong code to the step-up budget, as every proof does', async () => {
      const { userId, secret } = await requiredAccount();
      const wrong = ((Number.parseInt(await generate({ secret }), 10) % 999_983) + 1)
        .toString()
        .padStart(6, '0');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(start(userId, { code: wrong })).rejects.toMatchObject({
          auth: { code: 'totp-mismatch' },
        });
      }
      await expect(start(userId, { code: wrong })).rejects.toMatchObject({
        auth: { code: 'totp-locked' },
      });
    });
  });

  describe('the swap', () => {
    it('replaces the secret with a code from the new app, once, and says so', async () => {
      const { userId, secret } = await requiredAccount();
      const staged = await start(userId, { code: await generate({ secret }) });

      await confirm(userId, staged.rotationId, await generate({ secret: staged.secret }));

      expect(staff.users.get(userId)?.totpEnabled).toBe(true);
      expect(liveSecretOf(userId)).toBe(staged.secret);
      expect(rotatedAudited()).toBe(true);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]).toMatchObject({
        kind: 'securityChange',
        values: { change: 'twoFactorRotated' },
      });
      // Spent: a second confirm, even with a fresh correct code, finds nothing.
      await expect(
        confirm(userId, staged.rotationId, await generate({ secret: staged.secret })),
      ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
    });

    it('refuses a code from the old app, and keeps the old app working', async () => {
      const { userId, secret } = await requiredAccount();
      const staged = await start(userId, { code: await generate({ secret }) });

      await expect(
        confirm(userId, staged.rotationId, await generate({ secret })),
      ).rejects.toMatchObject({ auth: { code: 'totp-mismatch' } });

      expect(liveSecretOf(userId)).toBe(secret);
      expect(rotatedAudited()).toBe(false);
      expect(mail.sent).toHaveLength(0);
    });

    it('takes the account lock before it reads anything, at both steps', async () => {
      const { userId, secret } = await requiredAccount();

      const staged = await start(userId, { code: await generate({ secret }) });
      expect(passkeyRows.calls.filter((call) => call === 'lock')).toHaveLength(1);

      await confirm(userId, staged.rotationId, await generate({ secret: staged.secret }));
      expect(passkeyRows.calls.filter((call) => call === 'lock')).toHaveLength(2);
    });

    it('spends the step-up budget at every confirmation, so the staged secret cannot be walked', async () => {
      const { userId, secret } = await requiredAccount();
      const staged = await start(userId, { code: await generate({ secret }) });
      const wrong = ((Number.parseInt(await generate({ secret: staged.secret }), 10) % 999_983) + 1)
        .toString()
        .padStart(6, '0');

      // The start took one attempt of five; four wrong confirmations take the rest.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(confirm(userId, staged.rotationId, wrong)).rejects.toMatchObject({
          auth: { code: 'totp-mismatch' },
        });
      }

      // Even the right code is now refused, and nothing was swapped.
      await expect(
        confirm(userId, staged.rotationId, await generate({ secret: staged.secret })),
      ).rejects.toMatchObject({ auth: { code: 'totp-locked' } });
      expect(liveSecretOf(userId)).toBe(secret);
    });

    it('refuses a rotation staged before the app was replaced by another', async () => {
      const { userId, secret } = await requiredAccount();
      const first = await start(userId, { code: await generate({ secret }) });
      const second = await start(userId, { code: await nextCode(secret) });

      await confirm(userId, second.rotationId, await generate({ secret: second.secret }));

      // The first was ended by the second; and even one that survived would
      // name a secret that is no longer live.
      await expect(
        confirm(userId, first.rotationId, await generate({ secret: first.secret })),
      ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
      expect(liveSecretOf(userId)).toBe(second.secret);
    });

    it('refuses a rotation staged before the app was turned off and set up again', async () => {
      const { userId, secret } = await requiredAccount();
      // A recovery code starts it, leaving the code steps free for the two
      // changes after it, each of which spends one.
      const user = staff.users.get(userId);
      if (user === undefined) throw new Error('no user');
      user.recoveryCodesHashed = await hashRecoveryCodes(['RC-4KQ2-9XMT'], hasher);
      const staged = await start(userId, { recoveryCode: 'RC-4KQ2-9XMT' });

      // A required account may turn the app off only while a passkey remains.
      passkeyCounts.set(userId, 1);
      await service.disableTotp(userId, await generate({ secret }), tx());
      const enrolment = await service.enrolTotp(userId);
      await service.confirmTotp(userId, await nextCode(enrolment.secret), tx());

      await expect(
        confirm(userId, staged.rotationId, await generate({ secret: staged.secret })),
      ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
      expect(liveSecretOf(userId)).toBe(enrolment.secret);
    });

    it('ends an open rotation when the app is turned off', async () => {
      const { userId, secret } = await requiredAccount();
      const staged = await start(userId, { code: await generate({ secret }) });
      passkeyCounts.set(userId, 1);

      await service.disableTotp(userId, await nextCode(secret), tx());

      await expect(rotations.read(staged.rotationId)).resolves.toEqual({ status: 'expired' });
    });

    it('marks the confirming code as used, so it cannot also sign in', async () => {
      const { userId, secret } = await requiredAccount();
      const email = staff.users.get(userId)?.email ?? '';
      const staged = await start(userId, { code: await generate({ secret }) });
      const code = await generate({ secret: staged.secret });
      await confirm(userId, staged.rotationId, code);

      const started = await signIn({ email });
      if (started.kind !== 'totp-required') throw new Error('expected a challenge');
      await expect(
        service.verifyTotp({
          challengeId: started.challengeId,
          ip: '203.0.113.5',
          code,
          trustDevice: false,
          userAgent: undefined,
        }),
      ).rejects.toMatchObject({ auth: { code: 'totp-mismatch' } });
      expect(audit.actions()).toContain('auth.second_factor.replayed');
    });

    it('will not confirm a rotation whose app was turned off meanwhile', async () => {
      const { userId, secret } = await requiredAccount();
      const staged = await start(userId, { code: await generate({ secret }) });
      await staff.disableTotp(userId, undefined, {});

      await expect(
        confirm(userId, staged.rotationId, await generate({ secret: staged.secret })),
      ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
      expect(staff.users.get(userId)?.totpEnabled).toBe(false);
    });

    it('answers a code from the new app at sign-in, and refuses the old one', async () => {
      const { userId, secret } = await requiredAccount();
      const email = staff.users.get(userId)?.email ?? '';
      const staged = await start(userId, { code: await generate({ secret }) });
      await confirm(userId, staged.rotationId, await generate({ secret: staged.secret }));

      const started = await signIn({ email });
      if (started.kind !== 'totp-required') throw new Error('expected a challenge');

      await expect(
        service.verifyTotp({
          challengeId: started.challengeId,
          ip: '203.0.113.5',
          code: await generate({ secret }),
          trustDevice: false,
          userAgent: undefined,
        }),
      ).rejects.toMatchObject({ auth: { code: 'totp-mismatch' } });

      const again = await signIn({ email });
      if (again.kind !== 'totp-required') throw new Error('expected a challenge');
      const issued = await service.verifyTotp({
        challengeId: again.challengeId,
        ip: '203.0.113.5',
        code: await nextCode(staged.secret),
        trustDevice: false,
        userAgent: undefined,
      });
      expect(issued.issued.session.user.email).toBe(email);
    });

    it('refuses another account’s staged rotation', async () => {
      const { userId, secret } = await requiredAccount();
      const other = await requiredAccount();
      const staged = await start(userId, { code: await generate({ secret }) });

      await expect(
        confirm(other.userId, staged.rotationId, await generate({ secret: staged.secret })),
      ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
    });
  });
});
