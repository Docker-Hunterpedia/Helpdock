import { randomBytes } from 'node:crypto';
import {
  createKeyring,
  createSettings,
  encryptSecret,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import type { Brand, DbTransaction } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import argon2 from 'argon2';
import { generateKeyPair } from 'jose';
import { generate } from 'otplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../testing/auth-redis.js';
import type { RedisStub } from '../testing/redis-stub.js';
import { silentLogger } from '../testing/silent-logger.js';
import { AuthService } from './auth.service.js';
import type { AuthAuditEntry, AuthAuditTrail } from './auth-audit.js';
import type { AuthEmailRequest, AuthMail } from './auth-email.js';
import type { AuthFailure } from './auth-failure.js';
import { EmailTokenStore } from './email-token.store.js';
import { ExchangeStore } from './exchange.store.js';
import type { OauthService } from './oauth/oauth.service.js';
import { OauthError } from './oauth/oauth.service.js';
import { derivePepper, PasswordHasher } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { RefreshStore } from './session/refresh-store.js';
import { SessionService } from './session/session.service.js';
import type { StaffMembership, StaffRepository, StaffUser } from './staff.repository.js';
import { TotpChallengeStore } from './totp/challenge-store.js';
import { newTotpSecret } from './totp/totp.js';
import { TrustedDeviceStore } from './totp/trusted-device.js';
import { TotpStepStore } from './totp/used-steps.js';

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
  readonly users = new Map<string, StaffUser>();
  readonly memberships = new Map<string, StaffMembership[]>();
  readonly brands: Brand[] = [brand()];

  add(user: StaffUser, role: StaffMembership['role'] = 'agent', brandId = BRAND_ID): StaffUser {
    this.users.set(user.id, user);
    this.memberships.set(user.id, [
      { id: uuidv7(), userId: user.id, brandId, role, departmentIds: null, createdAt: new Date() },
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

  async stageTotpSecret(userId: string, totpSecretEncrypted: string): Promise<void> {
    this.#patch(userId, { totpSecretEncrypted, totpEnabled: false });
  }

  async enableTotp(userId: string, recoveryCodesHashed: string[]): Promise<void> {
    this.#patch(userId, { totpEnabled: true, recoveryCodesHashed });
  }

  async replaceRecoveryCodes(userId: string, recoveryCodesHashed: string[]): Promise<void> {
    this.#patch(userId, { recoveryCodesHashed });
  }

  async disableTotp(userId: string): Promise<void> {
    this.#patch(userId, { totpEnabled: false, totpSecretEncrypted: null, recoveryCodesHashed: [] });
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
  identity: { email: string; name: string | undefined } | Error = new OauthError('nope');

  isEnabled(): Promise<boolean> {
    return Promise.resolve(this.enabled);
  }

  start(): Promise<string> {
    if (!this.enabled) {
      throw new OauthError('not configured');
    }
    return Promise.resolve('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  }

  complete(): Promise<{ email: string; name: string | undefined }> {
    if (this.identity instanceof Error) {
      return Promise.reject(this.identity);
    }
    return Promise.resolve(this.identity);
  }
}

let stub: RedisStub;
let staff: FakeStaffRepository;
let oauth: FakeOauthService;
let mail: CollectingAuthMail;
let audit: RecordingAudit;
let settings: Settings;
let service: AuthService;
let hasher: PasswordHasher;
let sessions: SessionService;

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
  mail = new CollectingAuthMail();
  audit = new RecordingAudit();
  hasher = new PasswordHasher(MASTER_KEY);

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
  const repository = staff as unknown as StaffRepository;
  const refresh = new RefreshStore(created.redis);

  sessions = new SessionService({
    staff: repository,
    refresh,
    redis: created.redis,
    keys: { kid: 'k1', privateKey, publicKey },
    logger: silentLogger(),
    appUrl: APP_URL,
    settings,
  });
  service = new AuthService({
    staff: repository,
    sessions,
    hasher,
    challenges: new TotpChallengeStore(created.redis),
    steps: new TotpStepStore(created.redis),
    trustedDevices: new TrustedDeviceStore({ redis: created.redis, masterKey: MASTER_KEY }),
    tokens: new EmailTokenStore(created.redis),
    exchanges: new ExchangeStore(created.redis),
    limiter: new RateLimiter(created.redis),
    oauth: oauth as unknown as OauthService,
    settings,
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }),
    mail,
    audit,
    logger: silentLogger(),
    appUrl: APP_URL,
  });
});

describe('methods', () => {
  it('reports a provider with no client id as off', async () => {
    await expect(service.methods()).resolves.toEqual({
      password: true,
      magicLink: true,
      oauth: { google: false, github: false },
    });
  });

  it('reports one that is configured as on', async () => {
    oauth.enabled = true;

    await expect(service.methods()).resolves.toMatchObject({
      oauth: { google: true, github: true },
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

    await expect(signIn()).resolves.toMatchObject({ kind: 'totp-enrolment-required' });
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

  it('answers "unavailable" once the per-address budget is spent', async () => {
    staff.add(await newUser());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn({ password: 'nope' }).catch(() => undefined);
    }

    await expect(signIn()).rejects.toMatchObject({ auth: { code: 'unavailable' } });
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
    await service.verifyTotp({ challengeId, code, trustDevice: false, userAgent: undefined });

    await expect(
      service.verifyTotp({ challengeId, code, trustDevice: false, userAgent: undefined }),
    ).rejects.toMatchObject({ auth: { code: 'challenge-expired' } });
  });

  it('counts wrong codes down and then locks', async () => {
    const { challengeId } = await start();
    const codes: unknown[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service
        .verifyTotp({ challengeId, code: '000000', trustDevice: false, userAgent: undefined })
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

  it('refuses a challenge that was never issued', async () => {
    await expect(
      service.verifyTotp({
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
      service.useRecoveryCode({ challengeId: second.challengeId, code, userAgent: undefined }),
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
        challengeId: started.challengeId,
        code: 'RC-0000-0000',
        userAgent: undefined,
      })
      .catch(() => undefined);

    await expect(
      service.verifyTotp({
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
  it('sends nothing for an address nobody has', async () => {
    await service.requestMagicLink({ email: 'nobody@helpdock.com', ip: '203.0.113.5' });

    expect(mail.sent).toEqual([]);
  });

  it('queues one link for the account, lasting the configured minutes', async () => {
    const user = staff.add(await newUser());

    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' });

    expect(mail.sent).toEqual([
      {
        kind: 'magicLink',
        userId: user.id,
        url: expect.stringContaining(`${APP_URL}/api/auth/magic-link/`),
        expiresIn: 10,
        brandId: null,
      },
    ]);
  });

  it('queues nothing, and still resolves, for an account with no brand to work in', async () => {
    staff.add(await newUser());
    mail.hasBrand = false;

    await expect(
      service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' }),
    ).resolves.toBeUndefined();
    expect(mail.sent).toEqual([]);
  });

  it('signs in once and then the link is spent', async () => {
    staff.add(await newUser());
    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' });
    const token = tokenIn(mail.sent[0]?.url ?? '');

    await expect(service.consumeMagicLink(token, 'Firefox')).resolves.toMatchObject({
      kind: 'session',
    });
    await expect(service.consumeMagicLink(token, 'Firefox')).resolves.toBeNull();
  });

  it('still asks for the second factor when the account has one', async () => {
    const { user } = await withTotp();
    staff.add(user);
    await service.requestMagicLink({ email: user.email, ip: '203.0.113.5' });

    await expect(
      service.consumeMagicLink(tokenIn(mail.sent[0]?.url ?? ''), 'Firefox'),
    ).resolves.toMatchObject({ kind: 'totp-required' });
  });

  it('answers null for a link belonging to an account that has since been deactivated', async () => {
    const user = staff.add(await newUser());
    await service.requestMagicLink({ email: user.email, ip: '203.0.113.5' });
    staff.users.set(user.id, { ...user, status: 'deactivated' });

    await expect(
      service.consumeMagicLink(tokenIn(mail.sent[0]?.url ?? ''), 'Firefox'),
    ).resolves.toBeNull();
  });

  it('stops sending once the per-address budget is spent', async () => {
    staff.add(await newUser());

    for (let attempt = 0; attempt < 7; attempt += 1) {
      await service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' });
    }

    expect(mail.sent.length).toBeLessThanOrEqual(5);
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

describe('OAuth', () => {
  it('reports a provider that is not configured as unavailable', async () => {
    await expect(service.startOauth('google')).rejects.toMatchObject({
      auth: { code: 'unavailable' },
    });
  });

  it('hands back the provider URL when it is configured', async () => {
    oauth.enabled = true;

    await expect(service.startOauth('google')).resolves.toContain('accounts.google.com');
  });

  it('signs in an address this install already knows', async () => {
    staff.add(await newUser());
    oauth.identity = { email: 'lina@helpdock.com', name: 'Lina' };

    await expect(
      service.completeOauth({ provider: 'google', code: 'c', state: 's', userAgent: 'Firefox' }),
    ).resolves.toMatchObject({ kind: 'session' });
  });

  it('refuses an address that belongs to nobody, and creates no account', async () => {
    oauth.identity = { email: 'stranger@example.com', name: 'Stranger' };

    await expect(
      service.completeOauth({ provider: 'google', code: 'c', state: 's', userAgent: 'Firefox' }),
    ).rejects.toMatchObject({ auth: { code: 'no-account' } });
    expect(staff.users.size).toBe(0);
  });

  it('turns a provider failure into a sign-in failure, not a 500', async () => {
    oauth.identity = new OauthError('the state does not belong to this provider');

    await expect(
      service.completeOauth({ provider: 'github', code: 'c', state: 's', userAgent: 'Firefox' }),
    ).rejects.toMatchObject({ auth: { code: 'no-account' } });
  });

  it('reports an unexpected failure as unavailable rather than as no account', async () => {
    oauth.identity = new TypeError('the network went away');

    await expect(
      service.completeOauth({ provider: 'github', code: 'c', state: 's', userAgent: 'Firefox' }),
    ).rejects.toMatchObject({ auth: { code: 'unavailable' } });
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

    await expect(signIn()).resolves.toMatchObject({ kind: 'totp-enrolment-required' });
  });

  it('does the same for an install admin who is only an agent in their brand', async () => {
    staff.add(await newUser({ installAdmin: true }), 'agent');

    await expect(signIn()).resolves.toMatchObject({ kind: 'totp-enrolment-required' });
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
    if (started.kind !== 'totp-enrolment-required') {
      throw new Error('expected an enrolment challenge');
    }
    return started.challengeId;
  };

  it('stages a secret, turns it on, and opens the session the challenge stood in for', async () => {
    const challengeId = await challenge();
    const { secret } = await service.startEnrolment(challengeId);

    const { recoveryCodes, issued } = await service.completeEnrolment({
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
      service.completeEnrolment({ challengeId, code: '000000', userAgent: undefined }),
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
        values: { change: 'password' },
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
        values: { change: 'passwordReset' },
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

/** The token out of the one line of the message that is just a link. */
const tokenIn = (text: string): string =>
  (text.split('\n').find((line) => line.includes('/api/auth/magic-link/')) ?? '')
    .split('/')
    .at(-1) ?? '';

const resetTokenIn = (text: string): string => {
  const line = text.split('\n').find((candidate) => candidate.includes('/sign-in/reset')) ?? '';
  return new URL(line, APP_URL).searchParams.get('token') ?? '';
};
