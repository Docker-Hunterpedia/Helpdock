import { createKeyring, type Env, encryptSecret } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  settings,
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
import { dockerAvailable } from '../../testing/docker-available.js';
import { SoftwareAuthenticator } from '../../testing/software-authenticator.js';
import { forgetUsedTotpSteps } from '../../testing/staff-sign-in.js';
import { PasswordHasher } from '../password.js';
import { refreshCookieOf } from '../session/cookies.js';
import { newTotpSecret } from '../totp/totp.js';

/**
 * M18-04 over HTTP against a real Postgres and Redis: signing in with a
 * discoverable passkey alone. The authenticators are software ones that sign
 * with `node:crypto`; they can be told to omit user verification, count
 * backwards or report another person's user handle.
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
type RequestOptions = Parameters<SoftwareAuthenticator['assert']>[0];

describe.skipIf(!hasDocker)('passwordless sign-in with a passkey', () => {
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

  const optionsFromServer = async () => {
    const response = await call('POST', '/api/auth/passkey/options');
    expect(response.statusCode).toBe(200);
    return response.json() as { ceremonyId: string; options: RequestOptions };
  };

  const answerWith = async (
    authenticator: SoftwareAuthenticator,
    overrides: Partial<Parameters<SoftwareAuthenticator['assert']>[1]> = {},
  ) => {
    const { ceremonyId, options } = await optionsFromServer();
    return {
      ceremonyId,
      response: authenticator.assert(options, { origin: APP_URL, ...overrides }),
    };
  };

  const verify = (answer: unknown) => call('POST', '/api/auth/passkey/verify', answer);

  const authOf = (response: { json(): unknown }) =>
    (response.json() as { error: { auth: { code: string; attemptsLeft?: number } } }).error.auth;

  const sessionCookie = (response: { cookies: readonly { name: string }[] }) =>
    response.cookies.some((cookie) => cookie.name === REFRESH_COOKIE);

  const enforceSso = async (userId: string) =>
    withTenant(runtime.db, system, (tx) =>
      tx.insert(settings).values({
        brandId: INSTALL_SCOPE_BRAND_ID,
        updatedBy: userId,
        key: 'sso.enforced',
        value: 'true',
      }),
    );

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
    await withTenant(runtime.db, system, (tx) =>
      tx.delete(settings).where(eq(settings.key, 'sso.enforced')),
    );
  });

  describe('the options', () => {
    it('are discoverable, require user verification and name nobody', async () => {
      const account = await makeAccount('agent');
      await holdPasskey(account.id, new SoftwareAuthenticator());

      const first = await optionsFromServer();
      const second = await optionsFromServer();

      expect(first.options.allowCredentials ?? []).toEqual([]);
      expect(first.options.userVerification).toBe('required');
      expect(first.options.rpId).toBe('support.example.com');
      expect(first.ceremonyId).not.toBe(second.ceremonyId);
      expect(first.options.challenge).not.toBe(second.options.challenge);
      expect(JSON.stringify(first)).not.toContain(account.email);
    });

    it('are refused under SSO enforcement', async () => {
      const account = await makeAccount('agent');
      await enforceSso(account.id);

      const response = await call('POST', '/api/auth/passkey/options');

      expect(response.statusCode).toBe(403);
      expect(authOf(response).code).toBe('sso-required');
    });

    it('give the sign-in budget slot back, and have a bucket of their own', async () => {
      await optionsFromServer();

      const sign = await runtime.redis.keys('auth:rate:signin-ip*');
      const options = await runtime.redis.keys('auth:rate:passkey-signin-options*');
      const members = await Promise.all(sign.map((key) => runtime.redis.zcard(key)));
      expect(members.every((count) => count === 0)).toBe(true);
      expect(options).toHaveLength(1);
    });
  });

  describe('a good assertion', () => {
    it('opens the session a password and a second factor would, with no second factor', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator({ signCount: 3 });
      await holdPasskey(account.id, authenticator);

      const verified = await verify(await answerWith(authenticator));

      expect(verified.statusCode).toBe(201);
      expect(sessionCookie(verified)).toBe(true);
      const body = verified.json() as { kind: string; accessToken: string };
      expect(body.kind).toBe('session');
      const me = await call('GET', '/api/auth/me', undefined, body.accessToken);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ user: { id: account.id } });

      const [row] = await stored(account.id);
      expect(row?.signCount).toBe(3);
      expect(row?.lastUsedAt).not.toBeNull();
      const [succeeded] = await auditRows('auth.sign_in.succeeded', account.id);
      expect(succeeded?.meta).toMatchObject({ method: 'passkey', secondFactor: 'passkey-uv' });
    });

    it('answers with the same keys as a password and an authenticator app', async () => {
      const keyring = createKeyring(envFor());
      const withApp = await makeAccount('agent', {
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(SECRET, keyring),
      });
      const challenge = await call('POST', '/api/auth/sign-in', {
        email: withApp.email,
        password: PASSWORD,
      });
      const viaApp = await call('POST', '/api/auth/totp', {
        challengeId: (challenge.json() as { challengeId: string }).challengeId,
        code: await totpCode(SECRET),
        trustDevice: false,
      });
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);

      const viaPasskey = await verify(await answerWith(authenticator));

      expect(Object.keys(viaPasskey.json() as Json).sort()).toEqual(
        Object.keys(viaApp.json() as Json).sort(),
      );
    });

    it('satisfies the second-factor rule of an Admin with nothing else enrolled', async () => {
      const admin = await makeAccount('admin');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(admin.id, authenticator);

      const verified = await verify(await answerWith(authenticator));

      expect(verified.statusCode).toBe(201);
      expect(verified.json()).toMatchObject({ kind: 'session' });
    });

    it('refunds its slot of the sign-in budget', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);

      await verify(await answerWith(authenticator));

      const sign = await runtime.redis.keys('auth:rate:signin-ip*');
      const members = await Promise.all(sign.map((key) => runtime.redis.zcard(key)));
      expect(members.every((count) => count === 0)).toBe(true);
    });

    it('turns an invited account active, as every first proof of identity does', async () => {
      const invited = await makeAccount('agent', { status: 'invited' });
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(invited.id, authenticator);

      const verified = await verify(await answerWith(authenticator));

      expect(verified.statusCode).toBe(201);
      const [after] = await runtime.db.select().from(users).where(eq(users.id, invited.id));
      expect(after?.status).toBe('active');
    });
  });

  describe('every refusal', () => {
    const refusedBody = { error: { auth: { code: 'invalid-credentials' } } };

    const withoutRequestId = (response: { json(): unknown }) => {
      const { error } = response.json() as { error: Json };
      const { requestId: _requestId, ...rest } = error;
      return rest;
    };

    const expectRefused = (response: { statusCode: number; json(): unknown }) => {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject(refusedBody);
      expect(sessionCookie(response as never)).toBe(false);
    };

    it('answers identically for an unknown credential, a bad signature and a tampered one', async () => {
      const account = await makeAccount('agent');
      const known = new SoftwareAuthenticator();
      await holdPasskey(account.id, known);
      const stranger = new SoftwareAuthenticator();

      const unknown = await verify(await answerWith(stranger));
      const forgedSigner = await answerWith(stranger);
      const forged = await verify({
        ...forgedSigner,
        response: {
          ...forgedSigner.response,
          id: Buffer.from(known.credentialId).toString('base64url'),
          rawId: Buffer.from(known.credentialId).toString('base64url'),
        },
      });
      const good = await answerWith(known);
      const tampered = await verify({
        ...good,
        response: {
          ...good.response,
          response: {
            ...good.response.response,
            signature: Buffer.alloc(70, 1).toString('base64url'),
          },
        },
      });

      for (const response of [unknown, forged, tampered]) expectRefused(response);
      expect(withoutRequestId(forged)).toEqual(withoutRequestId(unknown));
      expect(withoutRequestId(tampered)).toEqual(withoutRequestId(unknown));
      const [unknownAudit] = await auditRows('auth.sign_in.failed', account.id);
      expect(unknownAudit?.meta).toMatchObject({ method: 'passkey', reason: 'bad-assertion' });
    });

    it('refuses an assertion without user verification, and keeps the counter', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator({ userVerified: false });
      await holdPasskey(account.id, authenticator);

      const response = await verify(await answerWith(authenticator));

      expectRefused(response);
      const [row] = await stored(account.id);
      expect(row?.lastUsedAt).toBeNull();
    });

    it('refuses a regressed counter, audits it and does not move the stored one', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator({ signCount: 10 });
      await holdPasskey(account.id, authenticator);
      await runtime.db
        .update(webauthnCredentials)
        .set({ signCount: 50 })
        .where(eq(webauthnCredentials.userId, account.id));

      const response = await verify(await answerWith(authenticator));

      expectRefused(response);
      const [row] = await stored(account.id);
      expect(row?.signCount).toBe(50);
      expect(await auditRows('auth.passkey.counter_regressed', account.id)).toHaveLength(1);
    });

    it('refuses a replay of a captured answer', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const captured = await answerWith(authenticator);
      expect((await verify(captured)).statusCode).toBe(201);

      const replay = await verify(captured);

      expectRefused(replay);
    });

    it('refuses an answer made for another origin, and one that claims a frame', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);

      expectRefused(
        await verify(await answerWith(authenticator, { origin: 'https://evil.example.com' })),
      );
      expectRefused(await verify(await answerWith(authenticator, { crossOrigin: true })));
    });

    it('refuses an assertion that reports another person’s user handle', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      await runtime.db
        .update(users)
        .set({ webauthnUserHandle: new Uint8Array(32).fill(7) })
        .where(eq(users.id, account.id));

      const wrong = await verify(
        await answerWith(authenticator, {
          userHandle: Buffer.alloc(32, 9).toString('base64url'),
        }),
      );
      const right = await verify(
        await answerWith(authenticator, {
          userHandle: Buffer.alloc(32, 7).toString('base64url'),
        }),
      );

      expectRefused(wrong);
      expect(right.statusCode).toBe(201);
    });

    it('is the same for a deactivated person and for one with no active brand', async () => {
      const unknown = await verify(await answerWith(new SoftwareAuthenticator()));
      const gone = await makeAccount('agent', { status: 'deactivated', deactivatedAt: new Date() });
      const goneKey = new SoftwareAuthenticator();
      await holdPasskey(gone.id, goneKey);
      const noBrand = await makeAccount('agent');
      await withTenant(runtime.db, { ...system, brandIds: [seeded.brandId] }, (tx) =>
        tx.delete(userBrandRoles).where(eq(userBrandRoles.userId, noBrand.id)),
      );
      const noBrandKey = new SoftwareAuthenticator();
      await holdPasskey(noBrand.id, noBrandKey);

      const deactivated = await verify(await answerWith(goneKey));
      const brandless = await verify(await answerWith(noBrandKey));

      for (const response of [deactivated, brandless]) {
        expectRefused(response);
        expect(withoutRequestId(response)).toEqual(withoutRequestId(unknown));
      }
      const [goneAudit] = await auditRows('auth.sign_in.failed', gone.id);
      expect(goneAudit?.meta).toMatchObject({ method: 'passkey', reason: 'unusable-account' });
      const [brandlessAudit] = await auditRows('auth.sign_in.failed', noBrand.id);
      expect(brandlessAudit?.meta).toMatchObject({ method: 'passkey', reason: 'no-brand-role' });
      const [row] = await stored(noBrand.id);
      expect(row?.lastUsedAt).toBeNull();
    });
  });

  describe('under SSO enforcement', () => {
    it('refuses a valid assertion with sso-required and opens no session', async () => {
      const account = await makeAccount('admin');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const answer = await answerWith(authenticator);
      await enforceSso(account.id);

      const response = await verify(answer);

      expect(response.statusCode).toBe(403);
      expect(authOf(response).code).toBe('sso-required');
      expect(sessionCookie(response)).toBe(false);
      const [row] = await stored(account.id);
      expect(row?.lastUsedAt).toBeNull();
    });
  });

  describe('the sign-in budget', () => {
    it('is shared with the password form and runs out on passkey failures', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const junk = {
        ceremonyId: 'A'.repeat(43),
        response: (await answerWith(new SoftwareAuthenticator())).response,
      };
      for (let batch = 0; batch < 10; batch += 1) {
        await Promise.all(Array.from({ length: 10 }, () => verify(junk)));
      }

      const passkey = await verify(await answerWith(authenticator).catch(() => junk));
      const password = await call('POST', '/api/auth/sign-in', {
        email: account.email,
        password: PASSWORD,
      });

      expect(passkey.statusCode).toBe(429);
      expect(password.statusCode).toBe(429);
      expect((await call('POST', '/api/auth/passkey/options')).statusCode).toBe(429);
    });

    it('runs out on password failures too, for a valid passkey', async () => {
      const account = await makeAccount('agent');
      const authenticator = new SoftwareAuthenticator();
      await holdPasskey(account.id, authenticator);
      const answer = await answerWith(authenticator);
      for (let batch = 0; batch < 10; batch += 1) {
        await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            call('POST', '/api/auth/sign-in', {
              email: `nobody-${batch}-${index}@example.com`,
              password: 'not the password at all',
            }),
          ),
        );
      }

      const response = await verify(answer);

      expect(response.statusCode).toBe(429);
      expect(sessionCookie(response)).toBe(false);
      const [row] = await stored(account.id);
      expect(row?.lastUsedAt).toBeNull();
    });
  });
});
