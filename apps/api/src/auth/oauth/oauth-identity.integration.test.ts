import { createKeyring, decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  userBrandRoles,
  userOauthIdentities,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type { OauthProvider } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { QueuedAuthMail } from '../../testing/auth-mail.js';
import { dockerAvailable } from '../../testing/docker-available.js';
import {
  createFakeGoogle,
  type FakeGoogle,
  fakeGithubFetch,
} from '../../testing/fake-oauth-providers.js';
import { PasswordHasher } from '../password.js';
import { oauthNonceCookie } from '../session/cookies.js';
import { OAUTH_STATE_TTL_SECONDS } from './oauth.service.js';

/**
 * Google and GitHub sign-in bound to the provider account (1.0.1, ADR 0051),
 * over HTTP against a real Postgres and Redis. The providers are faked at
 * `fetch`; Google's id token is a real signed JWT, so the audience, issuer
 * and signature checks run as in production.
 *
 * `user_oauth_identities` is a global table (`GLOBAL_TABLES`): nothing in the
 * database scopes it, so the last block proves the only ways to it are the
 * caller's own.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 51).toString('base64');
const APP_URL = 'https://support.example.com';
const PASSWORD = 'a long enough agent password';

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)('OAuth identities bound by subject', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let email: QueuedAuthMail;
  let google: FakeGoogle;

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_TOKEN: 'metrics-token-for-the-oauth-suite',
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

  const nonceCookieOf = (provider: OauthProvider): string =>
    oauthNonceCookie(APP_URL, OAUTH_STATE_TTL_SECONDS, provider).name;

  const post = (path: string, body: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      payload: JSON.stringify(body),
    });

  const get = (path: string, token?: string) =>
    app.inject({
      method: 'GET',
      url: path,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  /** An agent of the seeded brand, with a password and nothing else. */
  const addAgent = async (address: string): Promise<{ id: string; email: string }> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    await runtime.db.insert(users).values({
      id,
      email: address,
      name: address,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
    });
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .insert(userBrandRoles)
        .values({ userId: id, brandId: seeded.brandId, role: 'agent', departmentIds: [] }),
    );
    return { id, email: address };
  };

  const passwordSignIn = async (address: string): Promise<string> => {
    const response = await post('/api/auth/sign-in', { email: address, password: PASSWORD });
    expect(response.json()).toMatchObject({ kind: 'session' });
    return (response.json() as { accessToken: string }).accessToken;
  };

  /** Where the callback sent the browser, as the screen reads it. */
  const landing = (response: { headers: Record<string, unknown> }): URL =>
    new URL(String(response.headers.location));

  /** The provider redirect followed back to the callback, with `fetch` as the provider. */
  const callback = async (
    provider: OauthProvider,
    providerUrl: string,
    nonce: string,
    providerFetch: ReturnType<typeof vi.fn>,
  ) => {
    const state = new URL(providerUrl).searchParams.get('state') ?? '';
    vi.stubGlobal('fetch', providerFetch);
    try {
      return await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/${provider}/callback?code=c&state=${state}`,
        headers: { cookie: `${nonceCookieOf(provider)}=${nonce}` },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  };

  /** A sign-in from the button: start, then the callback. */
  const buttonSignIn = async (provider: OauthProvider, providerFetch: ReturnType<typeof vi.fn>) => {
    const started = await get(`/api/auth/oauth/${provider}/start`);
    const nonce =
      started.cookies.find((cookie) => cookie.name === nonceCookieOf(provider))?.value ?? '';
    return landing(
      await callback(provider, String(started.headers.location), nonce, providerFetch),
    );
  };

  /** A connect from the security routes: step-up, then the callback. */
  const connect = async (
    provider: OauthProvider,
    token: string,
    providerFetch: ReturnType<typeof vi.fn>,
  ) => {
    const started = await post(
      `/api/auth/oauth/${provider}/connect`,
      { currentPassword: PASSWORD },
      token,
    );
    expect(started.statusCode).toBe(201);
    const nonce =
      started.cookies.find((cookie) => cookie.name === nonceCookieOf(provider))?.value ?? '';
    return landing(
      await callback(provider, (started.json() as { url: string }).url, nonce, providerFetch),
    );
  };

  const googleAs = async (claims: Record<string, unknown>) =>
    google.fetch(await google.idToken({ email_verified: true, ...claims }));

  const identitiesOf = (userId: string) =>
    runtime.db
      .select({
        provider: userOauthIdentities.provider,
        subject: userOauthIdentities.providerSubject,
      })
      .from(userOauthIdentities)
      .where(eq(userOauthIdentities.userId, userId));

  const authRowsOf = (userId: string) =>
    withTenant(
      runtime.db,
      {
        brandIds: [INSTALL_SCOPE_BRAND_ID],
        departmentIds: 'all',
        principalType: 'system',
        principalId: 'test',
      },
      (tx) =>
        tx
          .select({ action: auditLog.action, actorType: auditLog.actorType, meta: auditLog.meta })
          .from(auditLog)
          .where(and(like(auditLog.action, 'auth.%'), eq(auditLog.targetId, userId)))
          .orderBy(desc(auditLog.createdAt)),
    );

  const securityNotices = async (address: string) =>
    (await email.all()).filter(
      (message) =>
        message.to.address === address && message.subject.includes('sign-in details changed'),
    );

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
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });
    email = new QueuedAuthMail({ db: runtime.db, keyring: createKeyring(env) });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
    google = await createFakeGoogle();
    for (const provider of ['google', 'github'] as const) {
      await runtime.settings.set(`oauth.${provider}.clientId`, 'client-id', { updatedBy: 'test' });
      await runtime.settings.set(`oauth.${provider}.clientSecret`, 'client-secret', {
        updatedBy: 'test',
      });
    }
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const keys = await runtime.redis.keys('auth:rate:*');
    if (keys.length > 0) {
      await runtime.redis.del(...keys);
    }
  });

  describe('the first link from the sign-in button', () => {
    it('binds a Workspace account whose hd is the address domain, audits it and tells the holder', async () => {
      const lina = await addAgent('lina@acme.test');
      await email.clear();

      const landed = await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-lina', email: lina.email, hd: 'acme.test' }),
      );

      expect(landed.pathname).toBe('/oauth/callback');
      expect(landed.searchParams.get('code')).not.toBeNull();
      expect(await identitiesOf(lina.id)).toEqual([{ provider: 'google', subject: 'g-lina' }]);
      expect(await authRowsOf(lina.id)).toContainEqual({
        action: 'auth.oauth.linked',
        actorType: 'system',
        meta: { provider: 'google', via: 'sign-in' },
      });
      const [notice] = await securityNotices(lina.email);
      expect(notice?.text).toContain('A Google account was connected to lina@acme.test.');
    });

    it('binds a Gmail address', async () => {
      const nour = await addAgent('nour.helpdock@gmail.com');

      const landed = await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-nour', email: nour.email }),
      );

      expect(landed.searchParams.get('code')).not.toBeNull();
      expect(await identitiesOf(nour.id)).toEqual([{ provider: 'google', subject: 'g-nour' }]);
    });

    it('refuses a consumer Google account on a non-Gmail address, and binds nothing', async () => {
      const omar = await addAgent('omar@acme.test');

      const landed = await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-omar-consumer', email: omar.email }),
      );

      expect(landed.searchParams.get('error')).toBe('oauth-link-required');
      expect(landed.searchParams.get('code')).toBeNull();
      expect(await identitiesOf(omar.id)).toEqual([]);
    });

    it('never links GitHub by address, verified or not', async () => {
      const sara = await addAgent('sara@acme.test');

      const landed = await buttonSignIn('github', fakeGithubFetch({ id: 9001, email: sara.email }));

      expect(landed.searchParams.get('error')).toBe('oauth-link-required');
      expect(await identitiesOf(sara.id)).toEqual([]);
    });
  });

  describe('a bound account', () => {
    it('signs in by subject when the provider reports another address', async () => {
      const rami = await addAgent('rami@acme.test');
      await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-rami', email: rami.email, hd: 'acme.test' }),
      );

      const landed = await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-rami', email: 'rami.personal@elsewhere.test' }),
      );
      const exchanged = await post('/api/auth/exchange', {
        code: landed.searchParams.get('code'),
      });

      expect(exchanged.json()).toMatchObject({ session: { user: { id: rami.id } } });
    });

    it('is not taken over by another Google account that now holds its address', async () => {
      const hala = await addAgent('hala@acme.test');
      await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-hala', email: hala.email, hd: 'acme.test' }),
      );

      const landed = await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-hala-recycled', email: hala.email, hd: 'acme.test' }),
      );

      expect(landed.searchParams.get('error')).toBe('oauth-identity-conflict');
      expect(await identitiesOf(hala.id)).toEqual([{ provider: 'google', subject: 'g-hala' }]);
    });

    it('still asks for the second factor after OAuth', async () => {
      const landed = await buttonSignIn(
        'google',
        await googleAs({ sub: 'g-admin', email: seeded.email, hd: 'helpdock.test' }),
      );

      expect(landed.searchParams.get('challenge')).not.toBeNull();
      expect(landed.searchParams.get('code')).toBeNull();
    });
  });

  describe('connecting from a session', () => {
    it('reconnects GitHub behind a step-up, signs in by it, and disconnects it again', async () => {
      const dina = await addAgent('dina@acme.test');
      const token = await passwordSignIn(dina.email);
      const github = fakeGithubFetch({ id: 4242, email: 'dina-old@acme.test' });
      await email.clear();

      const wrong = await post(
        '/api/auth/oauth/github/connect',
        { currentPassword: 'not the password' },
        token,
      );
      const connected = await connect('github', token, github);
      const signedIn = await buttonSignIn('github', github);

      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
      expect(connected.pathname).toBe('/me/security');
      expect(connected.searchParams.get('connected')).toBe('github');
      expect(signedIn.searchParams.get('code')).not.toBeNull();
      expect((await get('/api/auth/oauth/identities', token)).json()).toEqual({
        identities: [
          { provider: 'github', email: 'dina-old@acme.test', connectedAt: expect.any(String) },
        ],
        passwordSet: true,
      });

      const disconnected = await post(
        '/api/auth/oauth/github/disconnect',
        { currentPassword: PASSWORD },
        token,
      );
      const afterwards = await buttonSignIn('github', github);

      expect(disconnected.statusCode).toBe(204);
      expect(afterwards.searchParams.get('error')).toBe('oauth-link-required');
      expect(await identitiesOf(dina.id)).toEqual([]);
      expect((await authRowsOf(dina.id)).map((row) => row.action)).toEqual(
        expect.arrayContaining([
          'auth.step_up.refused',
          'auth.oauth.linked',
          'auth.oauth.unlinked',
        ]),
      );
      expect(await authRowsOf(dina.id)).toContainEqual({
        action: 'auth.oauth.linked',
        actorType: 'staff',
        meta: { provider: 'github', via: 'connect' },
      });
      expect((await securityNotices(dina.email)).map((notice) => notice.text)).toEqual([
        expect.stringContaining('A GitHub account was connected to dina@acme.test.'),
        expect.stringContaining('The GitHub account was disconnected from dina@acme.test.'),
      ]);
    });

    it('refuses to disconnect the last way in of an account with no password', async () => {
      const yara = await addAgent('yara@acme.test');
      const token = await passwordSignIn(yara.email);
      await connect('github', token, fakeGithubFetch({ id: 5150, email: yara.email }));
      await runtime.db.update(users).set({ passwordHash: null }).where(eq(users.id, yara.id));

      const listed = await get('/api/auth/oauth/identities', token);
      const refused = await post('/api/auth/oauth/github/disconnect', { code: '123456' }, token);

      expect(listed.json()).toMatchObject({ passwordSet: false });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { auth: { code: 'oauth-last-sign-in' } } });
      expect(await identitiesOf(yara.id)).toEqual([{ provider: 'github', subject: '5150' }]);
      // Refused before the step-up, so no attempt was spent on it.
      expect((await authRowsOf(yara.id)).map((row) => row.action)).not.toContain(
        'auth.step_up.refused',
      );
    });

    it('refuses to connect a provider account that is bound to somebody else', async () => {
      const first = await addAgent('first@acme.test');
      const second = await addAgent('second@acme.test');
      await connect(
        'github',
        await passwordSignIn(first.email),
        fakeGithubFetch({ id: 777, email: 'x@acme.test' }),
      );

      const landed = await connect(
        'github',
        await passwordSignIn(second.email),
        fakeGithubFetch({ id: 777, email: 'x@acme.test' }),
      );

      expect(landed.searchParams.get('error')).toBe('oauth-identity-conflict');
      expect(await identitiesOf(first.id)).toEqual([{ provider: 'github', subject: '777' }]);
      expect(await identitiesOf(second.id)).toEqual([]);
      expect((await authRowsOf(second.id)).map((row) => row.action)).toContain(
        'auth.oauth.link_refused',
      );
    });
  });

  describe('who can reach the table', () => {
    it('lists and removes only the caller’s own identities, and nothing without a session', async () => {
      const amal = await addAgent('amal@acme.test');
      const badr = await addAgent('badr@acme.test');
      await connect(
        'github',
        await passwordSignIn(amal.email),
        fakeGithubFetch({ id: 1001, email: amal.email }),
      );
      const badrToken = await passwordSignIn(badr.email);

      const listed = await get('/api/auth/oauth/identities', badrToken);
      const removed = await post(
        '/api/auth/oauth/github/disconnect',
        { currentPassword: PASSWORD },
        badrToken,
      );
      const anonymous = await get('/api/auth/oauth/identities');

      expect(listed.json()).toEqual({ identities: [], passwordSet: true });
      expect(removed.statusCode).toBe(204);
      expect(await identitiesOf(amal.id)).toEqual([{ provider: 'github', subject: '1001' }]);
      expect(anonymous.statusCode).toBe(401);
    });
  });
});
