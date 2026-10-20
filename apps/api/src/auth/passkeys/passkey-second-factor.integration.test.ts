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
  withTenant,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, gte, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { StaffRepository as StaffAdminRepository } from '../../staff/staff.repository.js';
import { dockerAvailable } from '../../testing/docker-available.js';
import { SoftwareAuthenticator } from '../../testing/software-authenticator.js';
import { forgetUsedTotpSteps } from '../../testing/staff-sign-in.js';
import { PasswordHasher } from '../password.js';
import { refreshCookieOf } from '../session/cookies.js';
import { newTotpSecret } from '../totp/totp.js';

/**
 * M18-03 over HTTP against a real Postgres and Redis: a passkey answering the
 * second-factor challenge beside an authenticator app and recovery codes, the
 * budget and lock they share, and enrolling a passkey as the first second
 * factor. The authenticators are software ones that sign with `node:crypto`.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 12);
const APP_URL = 'https://support.example.com';
const REFRESH_COOKIE = refreshCookieOf({ APP_URL }).name;
const PASSWORD = 'a long enough account password';
const SECRET = newTotpSecret();

const hasDocker = await dockerAvailable();

type Json = Record<string, unknown>;
type CreationOptions = Parameters<SoftwareAuthenticator['register']>[0];
type RequestOptions = Parameters<SoftwareAuthenticator['assert']>[0];

describe.skipIf(!hasDocker)('a passkey as the second factor', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let since: Date;

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY.toString('base64'),
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_TOKEN: 'metrics-token-for-the-second-factor-suite',
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

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    token: string | null = null,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const system = {
    brandIds: [INSTALL_SCOPE_BRAND_ID],
    departmentIds: 'all' as const,
    principalType: 'system' as const,
    principalId: 'test',
  };

  const hasher = new PasswordHasher(MASTER_KEY);

  /** An account with a password and a role in the seeded brand. */
  const makeAccount = async (
    role: 'admin' | 'agent',
    overrides: Partial<typeof users.$inferInsert> = {},
  ): Promise<{ id: string; email: string }> => {
    const id = uuidv7();
    const email = `${id}@example.com`;
    await runtime.db.insert(users).values({
      id,
      email,
      name: 'Lina Haddad',
      status: 'active',
      passwordHash: await hasher.hash(PASSWORD),
      ...overrides,
    });
    await withTenant(runtime.db, { ...system, brandIds: [seeded.brandId] }, (tx) =>
      tx.insert(userBrandRoles).values({ userId: id, brandId: seeded.brandId, role }),
    );
    return { id, email };
  };

  const holdPasskey = async (
    userId: string,
    authenticator: SoftwareAuthenticator,
    name = 'Key',
  ) => {
    await runtime.db.insert(webauthnCredentials).values({
      userId,
      credentialId: authenticator.credentialId,
      publicKey: authenticator.cosePublicKey,
      algorithm: -7,
      backupEligible: false,
      backedUp: false,
      name,
    });
  };

  const stored = (userId: string) =>
    runtime.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));

  const auditRows = (action: string, userId: string) =>
    withTenant(runtime.db, system, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, action),
            eq(auditLog.targetId, userId),
            gte(auditLog.createdAt, since),
          ),
        ),
    );

  const challengeFor = async (email: string) => {
    const response = await call('POST', '/api/auth/sign-in', { email, password: PASSWORD });
    return { response, body: response.json() as Json & { challengeId: string } };
  };

  const optionsFor = async (challengeId: string) => {
    const response = await call('POST', '/api/auth/passkey/second-factor/options', { challengeId });
    expect(response.statusCode).toBe(200);
    return response.json() as { ceremonyId: string; options: RequestOptions };
  };

  const answerWith = async (
    challengeId: string,
    authenticator: SoftwareAuthenticator,
    overrides: { origin?: string; challenge?: string } = {},
  ) => {
    const { ceremonyId, options } = await optionsFor(challengeId);
    return {
      challengeId,
      ceremonyId,
      response: authenticator.assert(options, {
        origin: overrides.origin ?? APP_URL,
        ...overrides,
      }),
      trustDevice: false,
    };
  };

  const authOf = (response: { json(): unknown }) =>
    (response.json() as { error: { auth: { code: string; attemptsLeft?: number } } }).error.auth;

  const sessionCookie = (response: { cookies: readonly { name: string }[] }) =>
    response.cookies.some((cookie) => cookie.name === REFRESH_COOKIE);

  const totpCode = async (secret: string): Promise<string> => {
    await forgetUsedTotpSteps(runtime.redis);
    return generate({ secret, period: 30 });
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    const env = envFor();
    const logger = createLogger({
      env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      level: 'info',
      destination: { write: () => {} },
    });
    runtime = await createRuntime({ env, logger });
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    const [clock] = await runtime.db.execute<{ now: Date }>(sql`SELECT now() AS now`);
    since = new Date(String(clock?.now));
  });

  afterEach(async () => {
    const keys = await runtime.redis.keys('auth:*');
    if (keys.length > 0) await runtime.redis.del(...keys);
  });

  describe('the challenge', () => {
    it('names the ways to answer it', async () => {
      const appOnly = await makeAccount('agent');
      await runtime.db
        .update(users)
        .set({ totpEnabled: true, totpSecretEncrypted: 'x' })
        .where(eq(users.id, appOnly.id));
      const both = await makeAccount('agent');
      await runtime.db
        .update(users)
        .set({ totpEnabled: true, totpSecretEncrypted: 'x' })
        .where(eq(users.id, both.id));
      await holdPasskey(both.id, new SoftwareAuthenticator());
      const passkeyOnly = await makeAccount('agent');
      await holdPasskey(passkeyOnly.id, new SoftwareAuthenticator());

      expect((await challengeFor(appOnly.email)).body).toMatchObject({
        kind: 'totp-required',
        factors: { totp: true, passkey: false },
      });
      expect((await challengeFor(both.email)).body).toMatchObject({
        factors: { totp: true, passkey: true },
      });
      expect((await challengeFor(passkeyOnly.email)).body).toMatchObject({
        factors: { totp: false, passkey: true },
      });
    });
  });

  describe('signing in with a passkey after the password', () => {
    it('opens a session, records the use, audits the factor and spends the challenge', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator({ signCount: 3 });
      await holdPasskey(account.id, authenticator);
      const { body } = await challengeFor(account.email);
      const answer = await answerWith(body.challengeId, authenticator);

      const verified = await call('POST', '/api/auth/passkey/second-factor/verify', answer);

      expect(verified.statusCode).toBe(201);
      expect(sessionCookie(verified)).toBe(true);
      expect(verified.json()).toMatchObject({ kind: 'session' });
      const [row] = await stored(account.id);
      expect(row?.signCount).toBe(3);
      expect(row?.lastUsedAt).not.toBeNull();
      const [succeeded] = await auditRows('auth.sign_in.succeeded', account.id);
      expect(succeeded?.meta).toMatchObject({ method: 'password', secondFactor: 'passkey' });

      const again = await call('POST', '/api/auth/passkey/second-factor/verify', answer);
      expect(again.statusCode).toBe(401);
      expect(authOf(again).code).toBe('challenge-expired');
    });

    it('trusts the browser when asked, as a code does', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const { body } = await challengeFor(account.email);

      const verified = await call('POST', '/api/auth/passkey/second-factor/verify', {
        ...(await answerWith(body.challengeId, authenticator)),
        trustDevice: true,
      });

      expect(verified.cookies.some((cookie) => cookie.name.endsWith('hd_trust'))).toBe(true);
    });

    it('refuses a replay of a captured answer on a new challenge, and the replay costs an attempt', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const first = await challengeFor(account.email);
      const captured = await answerWith(first.body.challengeId, authenticator);
      await call('POST', '/api/auth/passkey/second-factor/verify', captured);
      const second = await challengeFor(account.email);

      const replay = await call('POST', '/api/auth/passkey/second-factor/verify', {
        ...captured,
        challengeId: second.body.challengeId,
      });

      expect(replay.statusCode).toBe(401);
      expect(authOf(replay)).toEqual({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(sessionCookie(replay)).toBe(false);
    });

    it('refuses another account’s passkey, whoever signed the challenge', async () => {
      const mine = await makeAccount('agent');
      await holdPasskey(mine.id, new SoftwareAuthenticator());
      const theirs = await makeAccount('agent');
      const stranger = new SoftwareAuthenticator();
      await holdPasskey(theirs.id, stranger);
      const { body } = await challengeFor(mine.email);

      const verified = await call(
        'POST',
        '/api/auth/passkey/second-factor/verify',
        await answerWith(body.challengeId, stranger),
      );

      expect(verified.statusCode).toBe(401);
      expect(authOf(verified)).toEqual({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(sessionCookie(verified)).toBe(false);
      const [row] = await stored(theirs.id);
      expect(row?.lastUsedAt).toBeNull();
      const failed = await auditRows('auth.second_factor.failed', mine.id);
      expect(failed.map((entry) => entry.meta)).toContainEqual({
        factor: 'passkey',
        reason: 'wrong-user',
      });
    });

    it.each([
      ['a challenge that is not the ceremony’s', { challenge: 'A'.repeat(43) }],
      ['another origin', { origin: 'https://evil.example' }],
    ])('refuses an answer signed over %s', async (_label, overrides) => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const { body } = await challengeFor(account.email);

      const verified = await call(
        'POST',
        '/api/auth/passkey/second-factor/verify',
        await answerWith(body.challengeId, authenticator, overrides),
      );

      expect(verified.statusCode).toBe(401);
      expect(authOf(verified).code).toBe('passkey-invalid');
    });

    it('will not take a ceremony the options call never issued', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const { body } = await challengeFor(account.email);
      const { options } = await optionsFor(body.challengeId);

      const verified = await call('POST', '/api/auth/passkey/second-factor/verify', {
        challengeId: body.challengeId,
        ceremonyId: 'A'.repeat(43),
        response: authenticator.assert(options, { origin: APP_URL }),
        trustDevice: false,
      });

      expect(authOf(verified).code).toBe('passkey-invalid');
    });

    it('offers nothing without the first factor: an unknown challenge gets the same refusal', async () => {
      const response = await call('POST', '/api/auth/passkey/second-factor/options', {
        challengeId: uuidv7(),
      });

      expect(response.statusCode).toBe(401);
      expect(authOf(response).code).toBe('challenge-expired');
    });
  });

  describe('the budget and the lock shared with codes', () => {
    it('evaluates at most three guesses across a parallel burst of codes and passkeys', async () => {
      const account = await makeAccount('agent');
      await runtime.db
        .update(users)
        .set({
          totpEnabled: true,
          totpSecretEncrypted: encryptSecret(SECRET, createKeyring(envFor())),
        })
        .where(eq(users.id, account.id));
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const { body } = await challengeFor(account.email);
      const ready = await answerWith(body.challengeId, authenticator);
      const wrong = await Promise.all(
        Array.from({ length: 6 }, () => answerWith(body.challengeId, new SoftwareAuthenticator())),
      );

      const results = await Promise.all([
        ...wrong.map((answer) => call('POST', '/api/auth/passkey/second-factor/verify', answer)),
        ...Array.from({ length: 6 }, () =>
          call('POST', '/api/auth/totp', {
            challengeId: body.challengeId,
            code: '000000',
            trustDevice: false,
          }),
        ),
      ]);

      expect(results.some(sessionCookie)).toBe(false);
      const codes = results.map((result) => authOf(result).code);
      const evaluated = codes.filter(
        (code) => code === 'passkey-invalid' || code === 'totp-mismatch',
      );
      expect(evaluated.length).toBeLessThanOrEqual(2);
      expect(codes.filter((code) => code === 'totp-locked').length).toBeGreaterThanOrEqual(1);
      const failures = await auditRows('auth.second_factor.failed', account.id);
      expect(failures).toHaveLength(3);

      // The right passkey, minted before the burst, and the right password are refused now.
      const stillRight = await call('POST', '/api/auth/passkey/second-factor/verify', ready);
      expect(sessionCookie(stillRight)).toBe(false);
      const locked = await call('POST', '/api/auth/sign-in', {
        email: account.email,
        password: PASSWORD,
      });
      expect(locked.statusCode).toBe(429);
      expect(authOf(locked).code).toBe('totp-locked');
      expect(await auditRows('auth.account.locked', account.id)).not.toHaveLength(0);
    });

    it('lets the third attempt be a correct passkey after two wrong codes', async () => {
      const account = await makeAccount('agent');
      await runtime.db
        .update(users)
        .set({
          totpEnabled: true,
          totpSecretEncrypted: encryptSecret(SECRET, createKeyring(envFor())),
        })
        .where(eq(users.id, account.id));
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const { body } = await challengeFor(account.email);
      const answer = await answerWith(body.challengeId, authenticator);
      for (let tries = 0; tries < 2; tries += 1) {
        await call('POST', '/api/auth/totp', {
          challengeId: body.challengeId,
          code: '000000',
          trustDevice: false,
        });
      }

      const verified = await call('POST', '/api/auth/passkey/second-factor/verify', answer);

      expect(verified.statusCode).toBe(201);
      expect(sessionCookie(verified)).toBe(true);
    });
  });

  describe('enrolling a passkey as the first second factor', () => {
    const enrolmentFor = async () => {
      const account = await makeAccount('admin');
      const { body } = await challengeFor(account.email);
      expect(body.kind).toBe('totp-enrolment-required');
      return { account, challengeId: body.challengeId };
    };

    const registrationFor = async (
      challengeId: string,
      authenticator: SoftwareAuthenticator,
      origin = APP_URL,
    ) => {
      const begun = await call('POST', '/api/auth/enrolment/passkey/options', { challengeId });
      expect(begun.statusCode).toBe(200);
      const { ceremonyId, options } = begun.json() as {
        ceremonyId: string;
        options: CreationOptions;
      };
      return {
        challengeId,
        ceremonyId,
        response: authenticator.register(options, { origin }),
        name: 'MacBook Air · Touch ID',
      };
    };

    it('stores the passkey, draws ten recovery codes, opens the session and pins the RP ID', async () => {
      const { account, challengeId } = await enrolmentFor();

      const done = await call(
        'POST',
        '/api/auth/enrolment/passkey/confirm',
        await registrationFor(challengeId, new SoftwareAuthenticator()),
      );

      expect(done.statusCode).toBe(201);
      expect(sessionCookie(done)).toBe(true);
      const result = done.json() as { recoveryCodes: string[]; accessToken: string };
      expect(result.recoveryCodes).toHaveLength(10);
      expect(await stored(account.id)).toMatchObject([{ name: 'MacBook Air · Touch ID' }]);
      const [after] = await runtime.db.select().from(users).where(eq(users.id, account.id));
      expect(after?.recoveryCodesHashed).toHaveLength(10);
      expect(after?.totpEnabled).toBe(false);
      const [added] = await auditRows('auth.passkey.added', account.id);
      expect(added?.meta).toMatchObject({ during: 'enrolment' });
      const [succeeded] = await auditRows('auth.sign_in.succeeded', account.id);
      expect(succeeded?.meta).toMatchObject({ secondFactor: 'passkey' });
    });

    it('then asks for the passkey at the next sign-in, and a recovery code stands in for it', async () => {
      const { account, challengeId } = await enrolmentFor();
      const done = await call(
        'POST',
        '/api/auth/enrolment/passkey/confirm',
        await registrationFor(challengeId, new SoftwareAuthenticator()),
      );
      const [code] = (done.json() as { recoveryCodes: string[] }).recoveryCodes;

      const next = await challengeFor(account.email);
      expect(next.body).toMatchObject({
        kind: 'totp-required',
        factors: { totp: false, passkey: true },
      });
      const recovered = await call('POST', '/api/auth/recovery-code', {
        challengeId: next.body.challengeId,
        code,
      });
      expect(recovered.statusCode).toBe(201);
      expect(sessionCookie(recovered)).toBe(true);
    });

    it('charges a registration that does not verify an attempt, and stores nothing', async () => {
      const { account, challengeId } = await enrolmentFor();

      const refused = await call(
        'POST',
        '/api/auth/enrolment/passkey/confirm',
        await registrationFor(challengeId, new SoftwareAuthenticator(), 'https://evil.example'),
      );

      expect(refused.statusCode).toBe(401);
      expect(authOf(refused)).toEqual({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(await stored(account.id)).toEqual([]);
    });

    it('spends the challenge: it cannot enrol twice', async () => {
      const { challengeId } = await enrolmentFor();
      const registration = await registrationFor(challengeId, new SoftwareAuthenticator());
      await call('POST', '/api/auth/enrolment/passkey/confirm', registration);

      const again = await call('POST', '/api/auth/enrolment/passkey/confirm', registration);

      expect(again.statusCode).toBe(401);
      expect(authOf(again).code).toBe('challenge-expired');
    });

    it('will not start for a second-factor challenge', async () => {
      const account = await makeAccount('agent');
      await holdPasskey(account.id, new SoftwareAuthenticator());
      const { body } = await challengeFor(account.email);

      const refused = await call('POST', '/api/auth/enrolment/passkey/options', {
        challengeId: body.challengeId,
      });

      expect(refused.statusCode).toBe(401);
      expect(authOf(refused).code).toBe('challenge-expired');
    });

    it('locks after three failures, shared with codes', async () => {
      const { account, challengeId } = await enrolmentFor();
      const bad = () =>
        registrationFor(challengeId, new SoftwareAuthenticator(), 'https://evil.example');

      await call('POST', '/api/auth/enrolment/passkey/confirm', await bad());
      await call('POST', '/api/auth/enrolment/confirm', { challengeId, code: '000000' });
      const third = await call('POST', '/api/auth/enrolment/passkey/confirm', await bad());

      expect(authOf(third).code).toBe('totp-locked');
      const locked = await call('POST', '/api/auth/sign-in', {
        email: account.email,
        password: PASSWORD,
      });
      expect(locked.statusCode).toBe(429);
    });
  });

  describe('from the security page, with a session', () => {
    /** An agent without any second factor, which the install lets sign in with a password. */
    const agentSession = async () => {
      const account = await makeAccount('agent');
      const signedIn = await call('POST', '/api/auth/sign-in', {
        email: account.email,
        password: PASSWORD,
      });
      return { account, token: (signedIn.json() as { accessToken: string }).accessToken };
    };

    const register = async (token: string, authenticator: SoftwareAuthenticator) => {
      const begun = await call(
        'POST',
        '/api/me/passkeys/begin',
        { proof: { currentPassword: PASSWORD } },
        token,
      );
      const { ceremonyId, options } = begun.json() as {
        ceremonyId: string;
        options: CreationOptions;
      };
      return call(
        'POST',
        '/api/me/passkeys/finish',
        { ceremonyId, response: authenticator.register(options, { origin: APP_URL }), name: 'Key' },
        token,
      );
    };

    it('draws recovery codes with the first passkey, and not with the second', async () => {
      const { token } = await agentSession();

      const first = await register(token, new SoftwareAuthenticator());
      const second = await register(token, new SoftwareAuthenticator());

      expect((first.json() as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
      expect((second.json() as { recoveryCodes?: string[] }).recoveryCodes).toBeUndefined();
    });

    it('redraws the codes with a passkey assertion, and the old ones stop working', async () => {
      const { account, token } = await agentSession();
      const authenticator = new SoftwareAuthenticator();
      const first = await register(token, authenticator);
      const [oldCode] = (first.json() as { recoveryCodes: string[] }).recoveryCodes;
      const stepUp = await call('POST', '/api/me/passkeys/step-up/options', undefined, token);
      const { ceremonyId, options } = stepUp.json() as {
        ceremonyId: string;
        options: RequestOptions;
      };

      const redrawn = await call(
        'POST',
        '/api/me/passkeys/recovery-codes',
        { passkey: { ceremonyId, response: authenticator.assert(options, { origin: APP_URL }) } },
        token,
      );

      expect(redrawn.statusCode).toBe(200);
      expect((redrawn.json() as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
      const challenge = await challengeFor(account.email);
      const withOld = await call('POST', '/api/auth/recovery-code', {
        challengeId: challenge.body.challengeId,
        code: oldCode,
      });
      expect(withOld.statusCode).toBe(401);
    });

    it('redraws nothing for another account’s passkey', async () => {
      const { token } = await agentSession();
      const mine = new SoftwareAuthenticator();
      await register(token, mine);
      const stepUp = await call('POST', '/api/me/passkeys/step-up/options', undefined, token);
      const { ceremonyId, options } = stepUp.json() as {
        ceremonyId: string;
        options: RequestOptions;
      };
      const stranger = new SoftwareAuthenticator();
      await holdPasskey((await makeAccount('agent')).id, stranger);

      const redrawn = await call(
        'POST',
        '/api/me/passkeys/recovery-codes',
        { passkey: { ceremonyId, response: stranger.assert(options, { origin: APP_URL }) } },
        token,
      );

      expect(redrawn.statusCode).toBe(401);
    });
  });

  describe('the last second factor of an Admin', () => {
    it('is never lost when "remove the last passkey" races "turn the app off"', async () => {
      const keyring = createKeyring(envFor());
      const admin = await makeAccount('admin');
      const adminSignIn = async (): Promise<string> => {
        await runtime.db
          .update(users)
          .set({ totpEnabled: true, totpSecretEncrypted: encryptSecret(SECRET, keyring) })
          .where(eq(users.id, admin.id));
        const first = await challengeFor(admin.email);
        const verified = await call('POST', '/api/auth/totp', {
          challengeId: first.body.challengeId,
          code: await totpCode(SECRET),
          trustDevice: false,
        });
        return (verified.json() as { accessToken: string }).accessToken;
      };

      for (let round = 0; round < 6; round += 1) {
        await runtime.db.delete(webauthnCredentials);
        const token = await adminSignIn();
        await holdPasskey(admin.id, new SoftwareAuthenticator(), 'Only passkey');
        const [held] = await stored(admin.id);
        const budgets = await runtime.redis.keys('auth:rate:*');
        if (budgets.length > 0) await runtime.redis.del(...budgets);

        const [removed, disabled] = await Promise.all([
          call(
            'DELETE',
            `/api/me/passkeys/${held?.id}`,
            { proof: { currentPassword: PASSWORD } },
            token,
          ),
          call('POST', '/api/me/totp/disable', { code: await totpCode(SECRET) }, token),
        ]);

        const [after] = await runtime.db.select().from(users).where(eq(users.id, admin.id));
        const passkeys = await stored(admin.id);
        expect(after?.totpEnabled === true || passkeys.length > 0).toBe(true);
        expect([removed.statusCode, disabled.statusCode].filter((code) => code < 300)).toHaveLength(
          1,
        );
      }
    });

    it('may turn the app off while a passkey remains, and keeps the recovery codes', async () => {
      const keyring = createKeyring(envFor());
      const admin = await makeAccount('admin', {
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(SECRET, keyring),
        recoveryCodesHashed: ['hash-1', 'hash-2'],
      });
      await holdPasskey(admin.id, new SoftwareAuthenticator());
      const { body } = await challengeFor(admin.email);
      const token = (
        (
          await call('POST', '/api/auth/totp', {
            challengeId: body.challengeId,
            code: await totpCode(SECRET),
            trustDevice: false,
          })
        ).json() as { accessToken: string }
      ).accessToken;

      const disabled = await call(
        'POST',
        '/api/me/totp/disable',
        { code: await totpCode(SECRET) },
        token,
      );

      expect(disabled.statusCode).toBe(204);
      const [after] = await runtime.db.select().from(users).where(eq(users.id, admin.id));
      expect(after).toMatchObject({
        totpEnabled: false,
        recoveryCodesHashed: ['hash-1', 'hash-2'],
      });
    });

    it('refuses the removal of the last passkey of an Admin whose only factor it is', async () => {
      const admin = await makeAccount('admin');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(admin.id, authenticator);
      const { body } = await challengeFor(admin.email);
      const signedIn = await call(
        'POST',
        '/api/auth/passkey/second-factor/verify',
        await answerWith(body.challengeId, authenticator),
      );
      const token = (signedIn.json() as { accessToken: string }).accessToken;
      const [held] = await stored(admin.id);

      const removed = await call(
        'DELETE',
        `/api/me/passkeys/${held?.id}`,
        { proof: { currentPassword: PASSWORD } },
        token,
      );

      expect(removed.statusCode).toBe(409);
      expect(authOf(removed).code).toBe('second-factor-required');
      expect(await stored(admin.id)).toHaveLength(1);
    });
  });

  describe('a stale enrolment challenge', () => {
    const totpOf = async (userId: string) => {
      const [row] = await runtime.db.select().from(users).where(eq(users.id, userId));
      return row;
    };

    it('cannot replace the authenticator the account turned on after the challenge was handed out', async () => {
      const admin = await makeAccount('admin');
      const { body } = await challengeFor(admin.email);
      expect(body.kind).toBe('totp-enrolment-required');
      await runtime.db
        .update(users)
        .set({
          totpEnabled: true,
          totpSecretEncrypted: encryptSecret(SECRET, createKeyring(envFor())),
        })
        .where(eq(users.id, admin.id));
      const before = (await totpOf(admin.id))?.totpSecretEncrypted;

      const staged = await call('POST', '/api/auth/enrolment/start', {
        challengeId: body.challengeId,
      });
      const confirmed = await call('POST', '/api/auth/enrolment/confirm', {
        challengeId: body.challengeId,
        code: await totpCode(SECRET),
      });

      expect(staged.statusCode).toBe(401);
      expect(authOf(staged).code).toBe('challenge-expired');
      expect(confirmed.statusCode).toBe(401);
      expect(sessionCookie(confirmed)).toBe(false);
      expect(await totpOf(admin.id)).toMatchObject({
        totpEnabled: true,
        totpSecretEncrypted: before,
      });
    });

    it('cannot add an authenticator beside a passkey the account added after the challenge', async () => {
      const admin = await makeAccount('admin');
      const { body } = await challengeFor(admin.email);
      await holdPasskey(admin.id, new SoftwareAuthenticator());

      const staged = await call('POST', '/api/auth/enrolment/start', {
        challengeId: body.challengeId,
      });
      const passkeyOptions = await call('POST', '/api/auth/enrolment/passkey/options', {
        challengeId: body.challengeId,
      });

      expect(authOf(staged).code).toBe('challenge-expired');
      expect(passkeyOptions.statusCode).toBe(200);
      const done = await call('POST', '/api/auth/enrolment/passkey/confirm', {
        challengeId: body.challengeId,
        ceremonyId: (passkeyOptions.json() as { ceremonyId: string }).ceremonyId,
        response: new SoftwareAuthenticator().register(
          (passkeyOptions.json() as { options: CreationOptions }).options,
          { origin: APP_URL },
        ),
        name: 'Late',
      });
      expect(done.statusCode).toBe(401);
      expect(sessionCookie(done)).toBe(false);
      expect(await stored(admin.id)).toHaveLength(1);
      expect((await totpOf(admin.id))?.totpSecretEncrypted).toBeNull();
    });

    it('is not a way for a bare session to switch an Admin’s required app off', async () => {
      const admin = await makeAccount('admin', {
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(SECRET, createKeyring(envFor())),
      });
      const first = await challengeFor(admin.email);
      const signedIn = await call('POST', '/api/auth/totp', {
        challengeId: first.body.challengeId,
        code: await totpCode(SECRET),
        trustDevice: false,
      });
      const token = (signedIn.json() as { accessToken: string }).accessToken;
      const before = (await totpOf(admin.id))?.totpSecretEncrypted;

      const enrol = await call('POST', '/api/auth/totp/enrol', undefined, token);

      expect(enrol.statusCode).toBe(429);
      expect(authOf(enrol).code).toBe('unavailable');
      expect(await totpOf(admin.id)).toMatchObject({
        totpEnabled: true,
        totpSecretEncrypted: before,
      });
    });
  });

  describe('deleting a person', () => {
    it('takes their passkeys with them', async () => {
      const gone = await makeAccount('agent', { status: 'deactivated', deactivatedAt: new Date() });
      await holdPasskey(gone.id, new SoftwareAuthenticator());

      const anonymised = await withTenant(
        runtime.db,
        { ...system, brandIds: [seeded.brandId] },
        (tx) => new StaffAdminRepository().anonymise(tx, gone.id),
      );

      expect(anonymised).toBe(true);
      expect(await stored(gone.id)).toEqual([]);
    });
  });
});
