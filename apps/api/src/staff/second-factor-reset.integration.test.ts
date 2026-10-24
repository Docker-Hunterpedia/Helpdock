import { createKeyring, type Env, encryptSecret } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  userBrandRoles,
  users,
  uuidv7,
  webauthnCredentials,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type { SecondFactorSummary, StaffList } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { refreshCookieOf } from '../auth/session/cookies.js';
import { hashRecoveryCodes, newRecoveryCodes } from '../auth/totp/recovery-codes.js';
import { newTotpSecret } from '../auth/totp/totp.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { writeSsoSetting } from '../sso/sso-settings.js';
import { QueuedAuthMail } from '../testing/auth-mail.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { forgetUsedTotpSteps } from '../testing/staff-sign-in.js';
import { seedSystemSender } from '../testing/system-sender.js';

/**
 * #398 over HTTP against a real Postgres and Redis: an install admin resets
 * another person's second factor (DOMAIN-RULES §12.1 rule 8). The reset is one
 * transaction, so the tests look for what it removed, what it wrote beside that,
 * and that a refusal anywhere leaves every factor where it was.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 14);
const APP_URL = 'https://support.example.com';
const REFRESH_COOKIE = refreshCookieOf({ APP_URL }).name;
const PASSWORD = 'a long enough account password';
const WRONG_DIGEST = '0'.repeat(64);

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)('an install admin resets a second factor (#398)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let email: QueuedAuthMail;
  let adminToken: string;

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY.toString('base64'),
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      DATABASE_MIGRATION_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const hasher = new PasswordHasher(MASTER_KEY);
  const keyring = () => createKeyring(envFor());
  const system = {
    brandIds: [INSTALL_SCOPE_BRAND_ID],
    departmentIds: 'all' as const,
    principalType: 'system' as const,
    principalId: 'test',
  };

  const call = (
    method: 'GET' | 'POST',
    url: string,
    { body, token }: { body?: unknown; token?: string | null } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token ?? adminToken}` }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const staffError = (response: { json(): unknown }): string =>
    (response.json() as { error: { staff: { reason: string } } }).error.staff.reason;

  const signInWithTotp = async (address: string, secret: string, password = PASSWORD) => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: address, password }),
    });
    await forgetUsedTotpSteps(runtime.redis);
    return app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        challengeId: (first.json() as { challengeId: string }).challengeId,
        code: await generate({ secret, period: 30 }),
        trustDevice: false,
      }),
    });
  };

  interface Target {
    readonly id: string;
    readonly email: string;
    readonly secret: string;
    readonly recoveryCodes: string[];
  }

  const makeTarget = async (
    options: {
      totp?: boolean;
      passkeys?: number;
      installAdmin?: boolean;
      role?: 'admin' | 'agent';
    } = {},
  ): Promise<Target> => {
    const { totp = true, passkeys = 2, installAdmin = false, role = 'admin' } = options;
    const id = uuidv7();
    const secret = newTotpSecret();
    const recoveryCodes = newRecoveryCodes(3);
    const address = `${id}@example.com`;
    await runtime.db.insert(users).values({
      id,
      email: address,
      name: 'Lina Haddad',
      status: 'active',
      installAdmin,
      passwordHash: await hasher.hash(PASSWORD),
      recoveryCodesHashed:
        totp || passkeys > 0 ? await hashRecoveryCodes(recoveryCodes, hasher) : [],
      ...(totp ? { totpEnabled: true, totpSecretEncrypted: encryptSecret(secret, keyring()) } : {}),
    });
    await withTenant(runtime.db, { ...system, brandIds: [seeded.brandId] }, (tx) =>
      tx.insert(userBrandRoles).values({ userId: id, brandId: seeded.brandId, role }),
    );
    for (let index = 0; index < passkeys; index += 1) {
      const authenticator = new SoftwareAuthenticator();
      await runtime.db.insert(webauthnCredentials).values({
        userId: id,
        credentialId: authenticator.credentialId,
        publicKey: authenticator.cosePublicKey,
        algorithm: -7,
        backupEligible: false,
        backedUp: false,
        userVerified: true,
        name: `Key ${index + 1}`,
      });
    }
    return { id, email: address, secret, recoveryCodes };
  };

  const storedUser = async (id: string) => {
    const [row] = await runtime.db.select().from(users).where(eq(users.id, id));
    return row;
  };

  const passkeyCount = async (id: string): Promise<number> =>
    (await runtime.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, id)))
      .length;

  const resetAudits = async (targetId: string) =>
    withSystem(runtime.db, INSTALL_SCOPE_BRAND_ID, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'auth.second_factor.reset'), eq(auditLog.targetId, targetId)),
        ),
    );

  const summary = async (id: string): Promise<SecondFactorSummary> => {
    const response = await call('GET', `/api/install/staff/${id}/second-factor`);
    expect(response.statusCode).toBe(200);
    return response.json() as SecondFactorSummary;
  };

  const reset = (
    id: string,
    digest: string,
    proof: unknown = { currentPassword: seeded.password },
  ) => call('POST', `/api/install/staff/${id}/second-factor/reset`, { body: { proof, digest } });

  const setPolicy = (policy: { enforced: boolean; breakGlass?: string[] }) =>
    withSystem(runtime.db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
      await writeSsoSetting(tx, keyring(), {
        key: 'sso.enforced',
        value: policy.enforced,
        actorId: seeded.userId,
      });
      await writeSsoSetting(tx, keyring(), {
        key: 'sso.breakGlassUserIds',
        value: policy.breakGlass ?? [],
        actorId: seeded.userId,
      });
    });

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    const env = envFor();
    runtime = await createRuntime({
      env,
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
        destination: { write: () => {} },
      }),
    });
    app = await createApiApp({ runtime });
    email = new QueuedAuthMail({ db: runtime.db, keyring: createKeyring(env) });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
    await seedSystemSender(runtime.settings);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    const rateKeys = await runtime.redis.keys('auth:rate:*');
    if (rateKeys.length > 0) await runtime.redis.del(...rateKeys);
    await email.clear();
    const signedIn = await signInWithTotp(seeded.email, seeded.totpSecret ?? '', seeded.password);
    adminToken = (signedIn.json() as { accessToken: string }).accessToken;
  });

  afterEach(async () => {
    await setPolicy({ enforced: false });
  });

  it('removes the app, the passkeys, the recovery codes and every session, and writes the audit row and the notice together', async () => {
    const target = await makeTarget({ passkeys: 2 });
    const session = await signInWithTotp(target.email, target.secret);
    const refreshCookie = session.cookies.find((cookie) => cookie.name === REFRESH_COOKIE)?.value;
    expect(refreshCookie).toBeDefined();

    const shown = await summary(target.id);
    expect(shown).toMatchObject({ totp: true, passkeys: 2, recoveryCodes: 3 });
    const response = await reset(target.id, shown.digest);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ totp: true, passkeys: 2, recoveryCodes: 3 });
    expect(await storedUser(target.id)).toMatchObject({
      totpEnabled: false,
      totpSecretEncrypted: null,
      recoveryCodesHashed: [],
    });
    expect(await passkeyCount(target.id)).toBe(0);
    const [audit] = await resetAudits(target.id);
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: seeded.userId,
      meta: { totp: true, passkeys: 2, recoveryCodes: 3 },
    });
    const [notice] = await email.all();
    expect(notice?.to.address).toBe(target.email);
    expect(notice?.subject).toBe('Your second factor was reset');
    expect(notice?.text).toContain((await storedUser(seeded.userId))?.name ?? 'missing');

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: `${REFRESH_COOKIE}=${refreshCookie}` },
    });
    expect(refreshed.statusCode).toBe(401);

    const list = (
      await call('GET', `/api/brands/${seeded.brandId}/staff?search=${target.id}`)
    ).json() as StaffList;
    expect(list.staff[0]?.twoFactorEnabled).toBe(false);
  });

  it('sends an Admin to enrolment at the next sign-in, as a newly promoted Admin is', async () => {
    const target = await makeTarget({ passkeys: 0 });
    const shown = await summary(target.id);
    expect((await reset(target.id, shown.digest)).statusCode).toBe(200);

    const next = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: target.email, password: PASSWORD }),
    });

    expect(next.json()).toMatchObject({ kind: expect.stringMatching(/enrolment-required$/) });
  });

  it('accepts a passkey assertion from the admin as the step-up', async () => {
    const authenticator = new SoftwareAuthenticator();
    await runtime.db.insert(webauthnCredentials).values({
      userId: seeded.userId,
      credentialId: authenticator.credentialId,
      publicKey: authenticator.cosePublicKey,
      algorithm: -7,
      backupEligible: false,
      backedUp: false,
      userVerified: true,
      name: 'Admin key',
    });
    try {
      const target = await makeTarget({ passkeys: 1 });
      const shown = await summary(target.id);
      const begun = await call('POST', '/api/me/passkeys/step-up/options');
      const { ceremonyId, options } = begun.json() as {
        ceremonyId: string;
        options: Parameters<SoftwareAuthenticator['assert']>[0];
      };

      const response = await reset(target.id, shown.digest, {
        passkey: { ceremonyId, response: authenticator.assert(options, { origin: APP_URL }) },
      });

      expect(response.statusCode).toBe(200);
      expect(await passkeyCount(target.id)).toBe(0);
    } finally {
      await runtime.db
        .delete(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, seeded.userId));
    }
  });

  it('accepts a live authenticator code from the admin as the step-up', async () => {
    const target = await makeTarget();
    const shown = await summary(target.id);
    await forgetUsedTotpSteps(runtime.redis);

    const response = await reset(target.id, shown.digest, {
      code: await generate({ secret: seeded.totpSecret ?? '', period: 30 }),
    });

    expect(response.statusCode).toBe(200);
  });

  it('changes nothing for a wrong step-up proof', async () => {
    const target = await makeTarget();
    const shown = await summary(target.id);

    const response = await reset(target.id, shown.digest, { currentPassword: 'not the password' });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect((await storedUser(target.id))?.totpEnabled).toBe(true);
    expect(await passkeyCount(target.id)).toBe(2);
    expect(await resetAudits(target.id)).toHaveLength(0);
  });

  it('is all or nothing: a notice that cannot be queued leaves every factor and the audit alone', async () => {
    const target = await makeTarget();
    const shown = await summary(target.id);
    const ddl = createDb({ url: envFor().DATABASE_MIGRATION_URL, max: 1 });
    await ddl.db.execute(
      sql.raw(
        `CREATE FUNCTION refuse_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused'; END $$`,
      ),
    );
    await ddl.db.execute(
      sql.raw(
        'CREATE TRIGGER refuse_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION refuse_outbox()',
      ),
    );
    try {
      expect((await reset(target.id, shown.digest)).statusCode).toBe(500);
    } finally {
      await ddl.db.execute(sql.raw('DROP TRIGGER refuse_outbox ON outbox'));
      await ddl.db.execute(sql.raw('DROP FUNCTION refuse_outbox()'));
      await ddl.close();
    }

    expect((await storedUser(target.id))?.totpEnabled).toBe(true);
    expect((await storedUser(target.id))?.recoveryCodesHashed).toHaveLength(3);
    expect(await passkeyCount(target.id)).toBe(2);
    expect(await resetAudits(target.id)).toHaveLength(0);
  });

  it('refuses an admin resetting their own factors', async () => {
    const summaryResponse = await call('GET', `/api/install/staff/${seeded.userId}/second-factor`);
    const response = await reset(seeded.userId, WRONG_DIGEST);

    expect(summaryResponse.statusCode).toBe(409);
    expect(response.statusCode).toBe(409);
    expect(staffError(response)).toBe('self');
    expect((await storedUser(seeded.userId))?.totpEnabled).toBe(true);
  });

  it('refuses a person with no second factor', async () => {
    const target = await makeTarget({ totp: false, passkeys: 0 });

    const response = await reset(target.id, WRONG_DIGEST);

    expect(response.statusCode).toBe(409);
    expect(staffError(response)).toBe('not-resettable');
  });

  it('refuses a person who is not active', async () => {
    const target = await makeTarget();
    await runtime.db.update(users).set({ status: 'deactivated' }).where(eq(users.id, target.id));

    expect(staffError(await reset(target.id, WRONG_DIGEST))).toBe('not-resettable');
  });

  it('answers changed, and changes nothing, when the factors moved after the confirmation opened', async () => {
    const target = await makeTarget();
    const shown = await summary(target.id);
    await runtime.db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.userId, target.id), eq(webauthnCredentials.name, 'Key 1')));

    const response = await reset(target.id, shown.digest);

    expect(response.statusCode).toBe(409);
    expect(staffError(response)).toBe('second-factor-changed');
    expect((await storedUser(target.id))?.totpEnabled).toBe(true);
    expect(await passkeyCount(target.id)).toBe(1);
  });

  it('refuses the last break-glass admin while SSO is enforced, and allows one of two', async () => {
    const only = await makeTarget({ installAdmin: true, passkeys: 0 });
    await setPolicy({ enforced: true, breakGlass: [only.id] });
    const shown = await summary(only.id);

    const refused = await reset(only.id, shown.digest);

    expect(refused.statusCode).toBe(409);
    expect(staffError(refused)).toBe('last-break-glass');
    expect((await storedUser(only.id))?.totpEnabled).toBe(true);

    const other = await makeTarget({ installAdmin: true, passkeys: 0 });
    await setPolicy({ enforced: true, breakGlass: [only.id, other.id] });
    expect((await reset(only.id, (await summary(only.id)).digest)).statusCode).toBe(200);
  });

  it('allows a break-glass admin to be reset while SSO is not enforced', async () => {
    const only = await makeTarget({ installAdmin: true, passkeys: 0 });
    await setPolicy({ enforced: false, breakGlass: [only.id] });

    expect((await reset(only.id, (await summary(only.id)).digest)).statusCode).toBe(200);
  });

  describe('who may call it', () => {
    it('refuses a signed-in person who is not an install admin', async () => {
      const agent = await makeTarget({ totp: true, passkeys: 0, role: 'agent' });
      const signedIn = await signInWithTotp(agent.email, agent.secret);
      const token = (signedIn.json() as { accessToken: string }).accessToken;
      const target = await makeTarget();

      const summaryResponse = await call('GET', `/api/install/staff/${target.id}/second-factor`, {
        token,
      });
      const resetResponse = await call(
        'POST',
        `/api/install/staff/${target.id}/second-factor/reset`,
        {
          token,
          body: { proof: { currentPassword: PASSWORD }, digest: WRONG_DIGEST },
        },
      );

      expect(summaryResponse.statusCode).toBe(403);
      expect(resetResponse.statusCode).toBe(403);
      expect((await storedUser(target.id))?.totpEnabled).toBe(true);
    });

    it('refuses a call without a session', async () => {
      const target = await makeTarget();

      expect(
        (await call('GET', `/api/install/staff/${target.id}/second-factor`, { token: null }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await call('POST', `/api/install/staff/${target.id}/second-factor/reset`, {
            token: null,
            body: { proof: { currentPassword: PASSWORD }, digest: WRONG_DIGEST },
          })
        ).statusCode,
      ).toBe(401);
    });
  });

  it('is rate limited per admin: the eleventh try in an hour is refused', async () => {
    const target = await makeTarget();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(staffError(await reset(target.id, WRONG_DIGEST))).toBe('second-factor-changed');
    }

    const response = await reset(target.id, WRONG_DIGEST);

    expect(response.statusCode).toBe(429);
    expect(staffError(response)).toBe('reset-rate-limited');
  });
});
