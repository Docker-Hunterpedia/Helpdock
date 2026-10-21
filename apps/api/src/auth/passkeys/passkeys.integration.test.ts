import { createKeyring, type Env } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  settings as settingsTable,
  users,
  uuidv7,
  webauthnCredentials,
  withTenant,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, gte, sql } from 'drizzle-orm';
import { generateKeyPair } from 'jose';
import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { QueuedAuthMail } from '../../testing/auth-mail.js';
import { dockerAvailable } from '../../testing/docker-available.js';
import { SoftwareAuthenticator } from '../../testing/software-authenticator.js';
import { forgetUsedTotpSteps } from '../../testing/staff-sign-in.js';
import { hashToken, webauthnCeremonyKey } from '../redis-keys.js';
import { issueAccessToken } from '../session/access-token.js';
import { refreshCookieOf } from '../session/cookies.js';

/**
 * M18-02 over HTTP against a real Postgres and Redis: registering, renaming
 * and removing a passkey behind a step-up, and what each refusal leaves behind.
 * The authenticators are software ones that sign with `node:crypto`, so the
 * api verifies signatures it did not make.
 *
 * The seeded account is an install admin with an authenticator app, so it is
 * an account that must have a second factor.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 12).toString('base64');
const APP_URL = 'https://support.example.com';
const REFRESH_COOKIE = refreshCookieOf({ APP_URL }).name;

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)('passkeys on /api/me/passkeys', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let email: QueuedAuthMail;
  let accessToken: string;
  /** The audit rows of earlier tests stay; a test reads only its own. */
  let since: Date;

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_TOKEN: 'metrics-token-for-the-passkey-suite',
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
    token: string | null = accessToken,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const totpCode = async (): Promise<string> => {
    await forgetUsedTotpSteps(runtime.redis);
    return generate({ secret: seeded.totpSecret ?? '', period: 30 });
  };

  const signIn = async (): Promise<string> => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: seeded.email, password: seeded.password }),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        challengeId: (first.json() as { challengeId: string }).challengeId,
        code: await totpCode(),
        trustDevice: false,
      }),
    });
    expect(second.cookies.some((cookie) => cookie.name === REFRESH_COOKIE)).toBe(true);
    return (second.json() as { accessToken: string }).accessToken;
  };

  const password = { currentPassword: '' };

  const system = {
    brandIds: [INSTALL_SCOPE_BRAND_ID],
    departmentIds: 'all' as const,
    principalType: 'system' as const,
    principalId: 'test',
  };

  const auditRows = (action: string) =>
    withTenant(runtime.db, system, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, action),
            eq(auditLog.targetId, seeded.userId),
            gte(auditLog.createdAt, since),
          ),
        ),
    );

  const storedFor = (userId: string) =>
    runtime.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));

  /** A user with no brand and no way in; enough to own a credential. */
  const strangerWith = async (authenticator: SoftwareAuthenticator): Promise<string> => {
    const id = uuidv7();
    await runtime.db
      .insert(users)
      .values({ id, email: `${id}@example.com`, name: 'Stranger', status: 'active' });
    await runtime.db.insert(webauthnCredentials).values({
      userId: id,
      credentialId: authenticator.credentialId,
      publicKey: authenticator.cosePublicKey,
      algorithm: -7,
      backupEligible: false,
      backedUp: false,
      name: 'Stranger key',
    });
    return id;
  };

  /** The whole add: the step-up, the browser prompt, the name. */
  const addPasskey = async (
    authenticator: SoftwareAuthenticator,
    name = 'MacBook Air',
    token = accessToken,
  ) => {
    const begun = await call('POST', '/api/me/passkeys/begin', { proof: password }, token);
    expect(begun.statusCode).toBe(200);
    const { ceremonyId, options } = begun.json() as {
      ceremonyId: string;
      options: Parameters<SoftwareAuthenticator['register']>[0];
    };
    return call(
      'POST',
      '/api/me/passkeys/finish',
      { ceremonyId, response: authenticator.register(options, { origin: APP_URL }), name },
      token,
    );
  };

  const stepUp = async (authenticator: SoftwareAuthenticator, origin = APP_URL) => {
    const begun = await call('POST', '/api/me/passkeys/step-up/options');
    expect(begun.statusCode).toBe(200);
    const { ceremonyId, options } = begun.json() as {
      ceremonyId: string;
      options: Parameters<SoftwareAuthenticator['assert']>[0];
    };
    return { ceremonyId, response: authenticator.assert(options, { origin }) };
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
    email = new QueuedAuthMail({ db: runtime.db, keyring: createKeyring(env) });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
    password.currentPassword = seeded.password;
    accessToken = await signIn();
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
    const budgets = await runtime.redis.keys('auth:rate:*');
    if (budgets.length > 0) {
      await runtime.redis.del(...budgets);
    }
    await runtime.db.delete(webauthnCredentials);
    await runtime.db.update(users).set({ totpEnabled: true }).where(eq(users.id, seeded.userId));
    await email.clear();
  });

  describe('who may call it', () => {
    it.each([
      ['GET', '/api/me/passkeys'],
      ['POST', '/api/me/passkeys/begin'],
      ['POST', '/api/me/passkeys/finish'],
      ['POST', '/api/me/passkeys/step-up/options'],
      ['PATCH', `/api/me/passkeys/${uuidv7()}`],
      ['DELETE', `/api/me/passkeys/${uuidv7()}`],
    ] as const)('refuses %s %s without a session', async (method, path) => {
      const response = await call(method, path, {}, null);

      expect(response.statusCode).toBe(401);
    });

    it('refuses a token that claims the caller but is signed by another key', async () => {
      const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
      const forged = await issueAccessToken(
        {
          userId: seeded.userId,
          sessionId: uuidv7(),
          familyId: uuidv7(),
          brands: {},
          installAdmin: true,
        },
        { kid: 'not-this-install', privateKey, publicKey },
      );

      const response = await call('POST', '/api/me/passkeys/step-up/options', {}, forged);

      expect(response.statusCode).toBe(401);
    });
  });

  describe('adding a passkey', () => {
    it('lists none for an account that has none', async () => {
      const response = await call('GET', '/api/me/passkeys');

      expect(response.json()).toEqual({
        passkeys: [],
        limit: 10,
        state: 'available',
        removalBlocked: false,
        authenticatorApp: true,
      });
    });

    it('records whether the registration carried user verification, for break-glass (ADR 0053)', async () => {
      const verified = new SoftwareAuthenticator();
      const pinless = new SoftwareAuthenticator({ userVerified: false });

      expect((await addPasskey(verified, 'With PIN')).statusCode).toBe(201);
      expect((await addPasskey(pinless, 'No PIN')).statusCode).toBe(201);

      const rows = await storedFor(seeded.userId);
      expect(Object.fromEntries(rows.map((row) => [row.name, row.userVerified]))).toEqual({
        'With PIN': true,
        'No PIN': false,
      });
    });

    it('stores a passkey after a password step-up, pins the RP ID, audits it and emails the holder', async () => {
      const authenticator = new SoftwareAuthenticator({ backedUp: true, backupEligible: true });

      const finished = await addPasskey(authenticator, 'MacBook Air · Touch ID');

      expect(finished.statusCode).toBe(201);
      expect(finished.json()).toMatchObject({
        name: 'MacBook Air · Touch ID',
        lastUsedAt: null,
        synced: true,
      });
      const [row] = await storedFor(seeded.userId);
      expect(
        Buffer.from(row?.credentialId ?? []).equals(Buffer.from(authenticator.credentialId)),
      ).toBe(true);
      const [owned] = await runtime.db.select().from(users).where(eq(users.id, seeded.userId));
      expect(owned?.webauthnUserHandle).toHaveLength(32);

      const [added] = await auditRows('auth.passkey.added');
      expect(added?.meta).toEqual({
        passkey: row?.id,
        name: 'MacBook Air · Touch ID',
        synced: true,
      });
      expect(added?.actorType).toBe('staff');

      const sent = await email.all();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toBe('A passkey was added to your account');
      expect(sent[0]?.text).toContain('“MacBook Air · Touch ID” can now sign you in to Helpdock.');
      expect(sent[0]?.text).toContain('From: Chrome on macOS');
    });

    it('keeps the same user handle for a second passkey and excludes the first from the prompt', async () => {
      await addPasskey(new SoftwareAuthenticator());
      const [first] = await runtime.db.select().from(users).where(eq(users.id, seeded.userId));

      const begun = await call('POST', '/api/me/passkeys/begin', { proof: password });
      const { options } = begun.json() as {
        options: { excludeCredentials: unknown[]; user: { id: string } };
      };

      expect(options.excludeCredentials).toHaveLength(1);
      expect(options.user.id).toBe(
        Buffer.from(first?.webauthnUserHandle ?? []).toString('base64url'),
      );
    });

    it('accepts a live authenticator code as the step-up', async () => {
      const begun = await call('POST', '/api/me/passkeys/begin', {
        proof: { code: await totpCode() },
      });

      expect(begun.statusCode).toBe(200);
    });

    it('refuses a wrong password and stores nothing, nor sends anything', async () => {
      const response = await call('POST', '/api/me/passkeys/begin', {
        proof: { currentPassword: 'not the password' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(0);
      expect(await email.all()).toHaveLength(0);
    });

    it('refuses a proof that names two credentials, or none', async () => {
      const both = await call('POST', '/api/me/passkeys/begin', {
        proof: { currentPassword: seeded.password, code: '123456' },
      });
      const neither = await call('POST', '/api/me/passkeys/begin', { proof: {} });

      expect(both.statusCode).toBe(400);
      expect(neither.statusCode).toBe(400);
    });

    it('stops guessing at the step-up after five tries in fifteen minutes', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push(
          (
            await call('POST', '/api/me/passkeys/begin', {
              proof: { currentPassword: 'not the password' },
            })
          ).statusCode,
        );
      }

      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      const right = await call('POST', '/api/me/passkeys/begin', { proof: password });
      expect(right.statusCode).toBe(429);
    });

    it('refuses the eleventh passkey before it asks for a proof', async () => {
      for (let held = 0; held < 10; held += 1) {
        const authenticator = new SoftwareAuthenticator();
        await runtime.db.insert(webauthnCredentials).values({
          userId: seeded.userId,
          credentialId: authenticator.credentialId,
          publicKey: authenticator.cosePublicKey,
          algorithm: -7,
          backupEligible: false,
          backedUp: false,
          name: `Key ${held}`,
        });
      }

      const response = await call('POST', '/api/me/passkeys/begin', {
        proof: { currentPassword: 'not even the password' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'passkey-limit' } } });
    });

    it('lets only one of two parallel registrations take the last place', async () => {
      for (let held = 0; held < 9; held += 1) {
        const authenticator = new SoftwareAuthenticator();
        await runtime.db.insert(webauthnCredentials).values({
          userId: seeded.userId,
          credentialId: authenticator.credentialId,
          publicKey: authenticator.cosePublicKey,
          algorithm: -7,
          backupEligible: false,
          backedUp: false,
          name: `Key ${held}`,
        });
      }
      const prompts = await Promise.all(
        [new SoftwareAuthenticator(), new SoftwareAuthenticator()].map(async (authenticator) => {
          const begun = await call('POST', '/api/me/passkeys/begin', { proof: password });
          const { ceremonyId, options } = begun.json() as {
            ceremonyId: string;
            options: Parameters<SoftwareAuthenticator['register']>[0];
          };
          return {
            ceremonyId,
            response: authenticator.register(options, { origin: APP_URL }),
          };
        }),
      );

      const finished = await Promise.all(
        prompts.map((prompt) =>
          call('POST', '/api/me/passkeys/finish', { ...prompt, name: 'Parallel' }),
        ),
      );

      expect(finished.map((response) => response.statusCode).sort()).toEqual([201, 409]);
      expect(await storedFor(seeded.userId)).toHaveLength(10);
    });

    it('refuses an authenticator that is already stored', async () => {
      const authenticator = new SoftwareAuthenticator();
      await addPasskey(authenticator);

      const again = await addPasskey(authenticator, 'The same key');

      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: { auth: { code: 'passkey-duplicate' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(1);
    });
  });

  describe('the registration ceremony', () => {
    const begin = async () => {
      const begun = await call('POST', '/api/me/passkeys/begin', { proof: password });
      return begun.json() as {
        ceremonyId: string;
        options: Parameters<SoftwareAuthenticator['register']>[0];
      };
    };

    it('cannot be replayed: the second finish finds the ceremony spent', async () => {
      const authenticator = new SoftwareAuthenticator();
      const { ceremonyId, options } = await begin();
      const body = {
        ceremonyId,
        response: authenticator.register(options, { origin: APP_URL }),
        name: 'Once',
      };

      const first = await call('POST', '/api/me/passkeys/finish', body);
      const second = await call('POST', '/api/me/passkeys/finish', body);

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(401);
      expect(second.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(1);
    });

    it('refuses an answer made for another origin, and the ceremony is gone afterwards', async () => {
      const authenticator = new SoftwareAuthenticator();
      const { ceremonyId, options } = await begin();

      const wrong = await call('POST', '/api/me/passkeys/finish', {
        ceremonyId,
        response: authenticator.register(options, {
          origin: 'https://support.example.com.evil.test',
        }),
        name: 'Phished',
      });
      const right = await call('POST', '/api/me/passkeys/finish', {
        ceremonyId,
        response: authenticator.register(options, { origin: APP_URL }),
        name: 'Phished',
      });

      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
      expect(right.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(0);
      expect(await email.all()).toHaveLength(0);
    });

    it('refuses an answer made for another RP ID', async () => {
      const authenticator = new SoftwareAuthenticator();
      const { ceremonyId, options } = await begin();

      const response = await call('POST', '/api/me/passkeys/finish', {
        ceremonyId,
        response: authenticator.register(options, { origin: APP_URL, rpId: 'evil.test' }),
        name: 'Wrong RP',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(0);
    });

    it('refuses a ceremony that has expired', async () => {
      const authenticator = new SoftwareAuthenticator();
      const { ceremonyId, options } = await begin();
      await runtime.redis.del(webauthnCeremonyKey(hashToken(ceremonyId)));

      const response = await call('POST', '/api/me/passkeys/finish', {
        ceremonyId,
        response: authenticator.register(options, { origin: APP_URL }),
        name: 'Late',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
    });

    it('refuses a ceremony another browser session began', async () => {
      const authenticator = new SoftwareAuthenticator();
      const { ceremonyId, options } = await begin();
      const otherBrowser = await signIn();

      const response = await call(
        'POST',
        '/api/me/passkeys/finish',
        {
          ceremonyId,
          response: authenticator.register(options, { origin: APP_URL }),
          name: 'Borrowed',
        },
        otherBrowser,
      );

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(0);
    });

    it('refuses a step-up ceremony offered as a registration', async () => {
      await addPasskey(new SoftwareAuthenticator());
      const authenticator = new SoftwareAuthenticator();
      const { ceremonyId } = (await (
        await call('POST', '/api/me/passkeys/step-up/options')
      ).json()) as { ceremonyId: string };
      const { options } = await begin();

      const response = await call('POST', '/api/me/passkeys/finish', {
        ceremonyId,
        response: authenticator.register(options, { origin: APP_URL }),
        name: 'Wrong purpose',
      });

      expect(response.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(1);
    });

    it.each([
      ['a name of only spaces', { name: '   ' }],
      ['a name over 64 characters', { name: 'x'.repeat(65) }],
      ['a name with a control character', { name: 'bad\u0007name' }],
    ])('refuses %s', async (_label, patch) => {
      const authenticator = new SoftwareAuthenticator();
      const { ceremonyId, options } = await begin();

      const response = await call('POST', '/api/me/passkeys/finish', {
        ceremonyId,
        response: authenticator.register(options, { origin: APP_URL }),
        ...patch,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('step-up with a passkey', () => {
    it('refuses to offer one when the account holds none', async () => {
      const response = await call('POST', '/api/me/passkeys/step-up/options');

      expect(response.statusCode).toBe(401);
    });

    it('confirms a rename, and records the use', async () => {
      const authenticator = new SoftwareAuthenticator();
      const added = await addPasskey(authenticator);
      const id = (added.json() as { id: string }).id;
      const proof = await stepUp(authenticator);

      const response = await call('PATCH', `/api/me/passkeys/${id}`, {
        name: 'Renamed',
        proof: { passkey: proof },
      });

      expect(response.statusCode).toBe(200);
      const [row] = await storedFor(seeded.userId);
      expect(row?.name).toBe('Renamed');
      expect(row?.lastUsedAt).not.toBeNull();
      // The counter an assertion presents is the one before it signs.
      expect(row?.signCount).toBe(authenticator.signCount - 1);
    });

    it('cannot be replayed', async () => {
      const authenticator = new SoftwareAuthenticator();
      const id = ((await addPasskey(authenticator)).json() as { id: string }).id;
      const proof = { passkey: await stepUp(authenticator) };

      const first = await call('PATCH', `/api/me/passkeys/${id}`, { name: 'One', proof });
      const second = await call('PATCH', `/api/me/passkeys/${id}`, { name: 'Two', proof });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(401);
      expect(second.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
      expect((await storedFor(seeded.userId))[0]?.name).toBe('One');
    });

    it('refuses an assertion made for another origin and audits why', async () => {
      const authenticator = new SoftwareAuthenticator();
      const id = ((await addPasskey(authenticator)).json() as { id: string }).id;
      const proof = await stepUp(authenticator, 'https://support.example.com.evil.test');

      const response = await call('DELETE', `/api/me/passkeys/${id}`, {
        proof: { passkey: proof },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(1);
      expect((await auditRows('auth.step_up.refused')).map((row) => row.meta)).toContainEqual({
        reason: 'passkey-bad-assertion',
      });
    });

    it("refuses another account's passkey answering this account's ceremony", async () => {
      const mine = new SoftwareAuthenticator();
      const id = ((await addPasskey(mine)).json() as { id: string }).id;
      const theirs = new SoftwareAuthenticator();
      await strangerWith(theirs);
      const proof = await stepUp(theirs);

      const response = await call('DELETE', `/api/me/passkeys/${id}`, {
        proof: { passkey: proof },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(1);
      expect((await auditRows('auth.step_up.refused')).map((row) => row.meta)).toContainEqual({
        reason: 'passkey-wrong-user',
      });
    });

    it('refuses an assertion whose counter went backwards, and audits the regression', async () => {
      const authenticator = new SoftwareAuthenticator({ signCount: 10 });
      const id = ((await addPasskey(authenticator)).json() as { id: string }).id;
      // A real authenticator counts the registration too; this one does not.
      authenticator.signCount = 11;
      const proof = await stepUp(authenticator);
      await call('PATCH', `/api/me/passkeys/${id}`, { name: 'Used', proof: { passkey: proof } });
      authenticator.signCount = 3;

      const stale = await stepUp(authenticator);
      const response = await call('PATCH', `/api/me/passkeys/${id}`, {
        name: 'Cloned',
        proof: { passkey: stale },
      });

      expect(response.statusCode).toBe(401);
      expect((await auditRows('auth.passkey.counter_regressed')).length).toBe(1);
      expect((await storedFor(seeded.userId))[0]?.name).toBe('Used');
    });
  });

  describe('renaming and removing', () => {
    it('renames, audits the old and new names, and says nothing for an unchanged one', async () => {
      const id = ((await addPasskey(new SoftwareAuthenticator(), 'Old')).json() as { id: string })
        .id;

      const renamed = await call('PATCH', `/api/me/passkeys/${id}`, {
        name: ' New ',
        proof: password,
      });
      const unchanged = await call('PATCH', `/api/me/passkeys/${id}`, {
        name: 'New',
        proof: password,
      });

      expect(renamed.json()).toMatchObject({ id, name: 'New' });
      expect(unchanged.statusCode).toBe(200);
      expect((await auditRows('auth.passkey.renamed')).map((row) => row.meta)).toEqual([
        { passkey: id, from: 'Old', to: 'New' },
      ]);
    });

    it('removes one, audits it and tells the holder what still protects the account', async () => {
      await addPasskey(new SoftwareAuthenticator(), 'Laptop');
      const second = (await addPasskey(new SoftwareAuthenticator(), 'YubiKey 5C')).json() as {
        id: string;
      };
      await email.clear();

      const removed = await call('DELETE', `/api/me/passkeys/${second.id}`, { proof: password });

      expect(removed.statusCode).toBe(204);
      expect(await storedFor(seeded.userId)).toHaveLength(1);
      expect((await auditRows('auth.passkey.removed')).map((row) => row.meta)).toEqual([
        { passkey: second.id, name: 'YubiKey 5C' },
      ]);
      const [sent] = await email.all();
      expect(sent?.subject).toBe('A passkey was removed from your account');
      expect(sent?.text).toContain('You still have 1 passkey and an authenticator app.');
    });

    it('refuses to remove the last second factor of an account that must have one', async () => {
      const only = (await addPasskey(new SoftwareAuthenticator())).json() as { id: string };
      await runtime.db.update(users).set({ totpEnabled: false }).where(eq(users.id, seeded.userId));

      const list = await call('GET', '/api/me/passkeys');
      const removed = await call('DELETE', `/api/me/passkeys/${only.id}`, { proof: password });

      expect((list.json() as { removalBlocked: boolean }).removalBlocked).toBe(true);
      expect(removed.statusCode).toBe(409);
      expect(removed.json()).toMatchObject({ error: { auth: { code: 'second-factor-required' } } });
      expect(await storedFor(seeded.userId)).toHaveLength(1);
    });

    it('removes the last passkey when an authenticator app is still on', async () => {
      const only = (await addPasskey(new SoftwareAuthenticator())).json() as { id: string };

      const removed = await call('DELETE', `/api/me/passkeys/${only.id}`, { proof: password });

      expect(removed.statusCode).toBe(204);
    });

    it('refuses a wrong password and removes nothing', async () => {
      const only = (await addPasskey(new SoftwareAuthenticator())).json() as { id: string };

      const removed = await call('DELETE', `/api/me/passkeys/${only.id}`, {
        proof: { currentPassword: 'not the password' },
      });

      expect(removed.statusCode).toBe(401);
      expect(await storedFor(seeded.userId)).toHaveLength(1);
      expect(await auditRows('auth.passkey.removed')).toHaveLength(0);
    });
  });

  describe("another account's passkeys", () => {
    it('are not listed, renamed or removed, and a stranger id looks like a missing one', async () => {
      const strangerKey = new SoftwareAuthenticator();
      const strangerId = await strangerWith(strangerKey);
      const [theirs] = await storedFor(strangerId);
      const missing = uuidv7();

      const list = await call('GET', '/api/me/passkeys');
      const rename = await call('PATCH', `/api/me/passkeys/${theirs?.id}`, {
        name: 'Mine now',
        proof: password,
      });
      const remove = await call('DELETE', `/api/me/passkeys/${theirs?.id}`, { proof: password });
      const absent = await call('DELETE', `/api/me/passkeys/${missing}`, { proof: password });

      expect((list.json() as { passkeys: unknown[] }).passkeys).toEqual([]);
      expect(rename.statusCode).toBe(404);
      expect(remove.statusCode).toBe(404);
      expect(absent.statusCode).toBe(404);
      expect(remove.json()).toMatchObject({ error: { code: 'not_found' } });
      expect(absent.json()).toMatchObject({ error: { code: 'not_found' } });
      expect((await storedFor(strangerId))[0]?.name).toBe('Stranger key');
    });

    it("is not touched by a refused request spending this account's step-up budget", async () => {
      const strangerId = await strangerWith(new SoftwareAuthenticator());
      const [theirs] = await storedFor(strangerId);

      await call('DELETE', `/api/me/passkeys/${theirs?.id}`, { proof: password });

      const keys = await runtime.redis.keys('auth:rate:step-up:*');
      expect(keys).toHaveLength(0);
    });
  });

  describe('what a password reset leaves', () => {
    it('keeps the passkeys, and the notice names how many', async () => {
      await addPasskey(new SoftwareAuthenticator());
      await addPasskey(new SoftwareAuthenticator());
      await email.clear();

      await app.inject({
        method: 'POST',
        url: '/api/auth/password/forgot',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: seeded.email }),
      });
      const link = (await email.last()).text.split('\n').find((line) => line.startsWith('http'));
      const token = new URL(link ?? '').searchParams.get('token') ?? '';
      const reset = await app.inject({
        method: 'POST',
        url: '/api/auth/password/reset',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ token, password: 'a brand new long password' }),
      });

      expect(reset.statusCode).toBeLessThan(300);
      expect(await storedFor(seeded.userId)).toHaveLength(2);
      expect((await email.last()).text).toContain('Your 2 passkeys were kept');
    });
  });

  describe("the install admin's view on /api/install/passkeys", () => {
    /** What another host would have left behind, written the way the first registration writes it. */
    const pinTo = (rpId: string) =>
      withTenant(runtime.db, system, (tx) =>
        tx
          .insert(settingsTable)
          .values({
            key: 'auth.webauthn.rpId',
            brandId: INSTALL_SCOPE_BRAND_ID,
            value: JSON.stringify(rpId),
            updatedBy: 'test',
          })
          .onConflictDoUpdate({
            target: [settingsTable.key, settingsTable.brandId],
            set: { value: JSON.stringify(rpId) },
          }),
      );

    it.each([
      ['GET', '/api/install/passkeys'],
      ['POST', '/api/install/passkeys/move'],
    ] as const)('refuses %s %s without a session', async (method, path) => {
      expect((await call(method, path, undefined, null)).statusCode).toBe(401);
    });

    it('counts passkeys and the people holding them, and names the pinned RP ID', async () => {
      await addPasskey(new SoftwareAuthenticator(), 'One');
      await addPasskey(new SoftwareAuthenticator(), 'Two');
      await strangerWith(new SoftwareAuthenticator());

      const response = await call('GET', '/api/install/passkeys');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        state: 'available',
        rpId: 'support.example.com',
        pinnedRpId: 'support.example.com',
        pinLocked: false,
        passkeyCount: 3,
        holderCount: 2,
      });
    });

    it('refuses to move when nothing is paused, and removes nothing', async () => {
      await addPasskey(new SoftwareAuthenticator());

      const response = await call('POST', '/api/install/passkeys/move');

      expect(response.statusCode).toBe(409);
      expect(await storedFor(seeded.userId)).toHaveLength(1);
    });

    it('moves: removes every passkey, re-pins, audits, and tells the holder', async () => {
      await addPasskey(new SoftwareAuthenticator(), 'One');
      await addPasskey(new SoftwareAuthenticator(), 'Two');
      await email.clear();
      await pinTo('admin.example.com');

      const paused = await call('GET', '/api/install/passkeys');
      expect(paused.json()).toMatchObject({
        state: 'paused',
        rpId: 'support.example.com',
        pinnedRpId: 'admin.example.com',
      });

      const moved = await call('POST', '/api/install/passkeys/move');

      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toEqual({
        rpId: 'support.example.com',
        passkeysRemoved: 2,
        holdersNotified: 1,
      });
      expect(await storedFor(seeded.userId)).toHaveLength(0);
      const after = await call('GET', '/api/install/passkeys');
      expect(after.json()).toMatchObject({
        state: 'available',
        pinnedRpId: 'support.example.com',
        passkeyCount: 0,
      });
      const [moveAudit] = await auditRows('auth.passkey.rp_moved');
      expect(moveAudit?.meta).toEqual({
        from: 'admin.example.com',
        to: 'support.example.com',
        passkeys: 2,
        holders: 1,
      });
      expect((await email.last()).subject).toBe('Your passkeys were removed');
      expect((await addPasskey(new SoftwareAuthenticator(), 'Again')).statusCode).toBe(201);
    });
  });
});
