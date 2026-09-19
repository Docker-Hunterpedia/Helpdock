import { randomBytes } from 'node:crypto';
import type { EmailMessage, EmailSender } from '@helpdock/channels';
import {
  createKeyring,
  createSettings,
  encryptSecret,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import type { Brand } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import argon2 from 'argon2';
import { generateKeyPair } from 'jose';
import { generate } from 'otplib';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../testing/auth-redis.js';
import type { RedisStub } from '../testing/redis-stub.js';
import { silentLogger } from '../testing/silent-logger.js';
import { AuthService } from './auth.service.js';
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
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** Just enough of the repository to answer the service, all in memory. */
class FakeStaffRepository {
  readonly users = new Map<string, StaffUser>();
  readonly memberships = new Map<string, StaffMembership[]>();
  readonly brands: Brand[] = [brand()];

  add(user: StaffUser, role: StaffMembership['role'] = 'admin', brandId = BRAND_ID): StaffUser {
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

class CollectingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
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
let email: CollectingEmailSender;
let settings: Settings;
let service: AuthService;
let hasher: PasswordHasher;

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
  email = new CollectingEmailSender();
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

  service = new AuthService({
    staff: repository,
    sessions: new SessionService({
      staff: repository,
      refresh,
      redis: created.redis,
      keys: { kid: 'k1', privateKey, publicKey },
      logger: silentLogger(),
      appUrl: APP_URL,
      settings,
    }),
    hasher,
    challenges: new TotpChallengeStore(created.redis),
    trustedDevices: new TrustedDeviceStore({ redis: created.redis, masterKey: MASTER_KEY }),
    tokens: new EmailTokenStore(created.redis),
    exchanges: new ExchangeStore(created.redis),
    limiter: new RateLimiter(created.redis),
    oauth: oauth as unknown as OauthService,
    settings,
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY_B64 }),
    email,
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

    expect(email.sent).toEqual([]);
  });

  it('sends a link in the recipient own language', async () => {
    staff.add(await newUser({ locale: 'ar' }));

    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' });

    expect(email.sent[0]?.locale).toBe('ar');
    expect(email.sent[0]?.text).toContain('/api/auth/magic-link/');
  });

  it('signs in once and then the link is spent', async () => {
    staff.add(await newUser());
    await service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' });
    const token = tokenIn(email.sent[0]?.text ?? '');

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
      service.consumeMagicLink(tokenIn(email.sent[0]?.text ?? ''), 'Firefox'),
    ).resolves.toMatchObject({ kind: 'totp-required' });
  });

  it('answers null for a link belonging to an account that has since been deactivated', async () => {
    const user = staff.add(await newUser());
    await service.requestMagicLink({ email: user.email, ip: '203.0.113.5' });
    staff.users.set(user.id, { ...user, status: 'deactivated' });

    await expect(
      service.consumeMagicLink(tokenIn(email.sent[0]?.text ?? ''), 'Firefox'),
    ).resolves.toBeNull();
  });

  it('stops sending once the per-address budget is spent', async () => {
    staff.add(await newUser());

    for (let attempt = 0; attempt < 7; attempt += 1) {
      await service.requestMagicLink({ email: 'lina@helpdock.com', ip: '203.0.113.5' });
    }

    expect(email.sent.length).toBeLessThanOrEqual(5);
  });
});

describe('the password reset', () => {
  it('sends nothing for an address nobody has', async () => {
    await service.requestPasswordReset({ email: 'nobody@helpdock.com', ip: '203.0.113.5' });

    expect(email.sent).toEqual([]);
  });

  it('changes the password and ends every session', async () => {
    const user = staff.add(await newUser());
    const opened = await signIn();
    if (opened.kind !== 'session') {
      throw new Error('expected a session');
    }
    await service.requestPasswordReset({ email: user.email, ip: '203.0.113.5' });
    const token = resetTokenIn(email.sent[0]?.text ?? '');

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
    const token = resetTokenIn(email.sent[0]?.text ?? '');
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
        token: tokenIn(email.sent[0]?.text ?? ''),
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
    const user = staff.add(await newUser());

    await expect(service.me(user.id)).resolves.toMatchObject({
      user: { email: user.email, role: 'admin' },
      brands: [{ ticketPrefix: 'HD' }],
    });
  });

  it('answers null for an account that cannot use the admin', async () => {
    await expect(service.me(uuidv7())).resolves.toBeNull();
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

/** The token out of the one line of the message that is just a link. */
const tokenIn = (text: string): string =>
  (text.split('\n').find((line) => line.includes('/api/auth/magic-link/')) ?? '')
    .split('/')
    .at(-1) ?? '';

const resetTokenIn = (text: string): string => {
  const line = text.split('\n').find((candidate) => candidate.includes('/sign-in/reset')) ?? '';
  return new URL(line, APP_URL).searchParams.get('token') ?? '';
};
