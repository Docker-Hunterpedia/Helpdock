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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { CustomFetch } from 'openid-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { QueuedAuthMail } from '../../testing/auth-mail.js';
import { dockerAvailable } from '../../testing/docker-available.js';
import { createFakeMicrosoft, type FakeMicrosoft } from '../../testing/fake-oauth-providers.js';
import { EmailTokenStore } from '../email-token.store.js';
import { PasswordHasher } from '../password.js';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../principal-resolver.js';
import { oauthNonceCookie } from '../session/cookies.js';
import { OAUTH_STATE_TTL_SECONDS } from './oauth.service.js';
import { OauthIdentityRepository } from './oauth-identity.repository.js';

/**
 * Microsoft sign-in (M18-08) over HTTP against a real Postgres and Redis. Entra
 * is a stand-in behind the service's transport: discovery, the key set and the
 * token endpoint answer for one tenant, with a real signed id token, so the
 * library's issuer, audience, nonce and signature checks run as in production.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 52).toString('base64');
const APP_URL = 'https://support.example.com';
const PASSWORD = 'a long enough agent password';
const TENANT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_TENANT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)('Microsoft sign-in', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let microsoft: FakeMicrosoft;
  let email: QueuedAuthMail;
  /** A second app on the same runtime that takes the dev principal header, for the install-admin route. */
  let devApp: ApiApp;
  /** What the stand-in's token endpoint answers with next. */
  let nextIdToken = '';

  const transport: CustomFetch = (input, init) => microsoft.transport(nextIdToken)(input, init);

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_TOKEN: 'metrics-token-for-the-microsoft-suite',
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

  const nonceCookie = oauthNonceCookie(APP_URL, OAUTH_STATE_TTL_SECONDS, 'microsoft');

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

  const landing = (response: { headers: Record<string, unknown> }): URL =>
    new URL(String(response.headers.location));

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

  const addInvited = async (address: string): Promise<{ id: string; token: string }> => {
    const id = uuidv7();
    await runtime.db.insert(users).values({ id, email: address, name: address, status: 'invited' });
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .insert(userBrandRoles)
        .values({ userId: id, brandId: seeded.brandId, role: 'agent', departmentIds: [] }),
    );
    const token = await new EmailTokenStore(runtime.redis).issue(
      {
        purpose: 'invite',
        userId: id,
        email: address,
        brandId: seeded.brandId,
        role: 'agent',
        departmentIds: [],
        issuedAt: Date.now(),
      },
      3_600,
    );
    return { id, token };
  };

  const claimsFor = (address: string, overrides: Record<string, unknown> = {}) => ({
    tid: TENANT,
    oid: uuidv7(),
    email: address,
    xms_edov: true,
    acct: 0,
    name: 'Test',
    ...overrides,
  });

  /** The browser's half: start, then the callback with the id token the stand-in is told to issue. */
  const buttonSignIn = async (
    claims: Record<string, unknown>,
    token: { issuer?: string; audience?: string } = {},
  ) => {
    const started = await app.inject({ method: 'GET', url: '/api/auth/oauth/microsoft/start' });
    expect(started.statusCode).toBe(302);
    const authorization = new URL(String(started.headers.location));
    nextIdToken = await microsoft.idToken(claims, {
      ...token,
      nonce: authorization.searchParams.get('nonce') ?? '',
    });
    const cookie = started.cookies.find((candidate) => candidate.name === nonceCookie.name)?.value;
    const state = authorization.searchParams.get('state') ?? '';
    const call = () =>
      app.inject({
        method: 'GET',
        url: `/api/auth/oauth/microsoft/callback?code=c&state=${state}`,
        headers: { cookie: `${nonceCookie.name}=${cookie}` },
      });

    return { authorization, call, landed: async () => landing(await call()) };
  };

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

  const failuresWithNoAccount = () =>
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
          .select({ meta: auditLog.meta })
          .from(auditLog)
          .where(eq(auditLog.action, 'auth.sign_in.failed')),
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
    microsoft = await createFakeMicrosoft({ tenantId: TENANT });
    app = await createApiApp({ runtime, oauthTransport: transport });
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';
    try {
      devApp = await createApiApp({ runtime, oauthTransport: transport });
    } finally {
      delete process.env[DEV_PRINCIPAL_ENV_KEY];
    }
    email = new QueuedAuthMail({ db: runtime.db, keyring: createKeyring(env) });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
    await runtime.settings.set('oauth.microsoft.tenantId', TENANT, { updatedBy: 'test' });
    await runtime.settings.set('oauth.microsoft.clientId', 'client-id', { updatedBy: 'test' });
    await runtime.settings.set('oauth.microsoft.clientSecret', 'client-secret', {
      updatedBy: 'test',
    });
  }, 300_000);

  afterAll(async () => {
    await devApp?.close();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    const keys = await runtime.redis.keys('auth:rate:*');
    if (keys.length > 0) {
      await runtime.redis.del(...keys);
    }
  });

  it('offers the button once the tenant, client id and secret are set', async () => {
    const methods = await app.inject({ method: 'GET', url: '/api/auth/methods' });

    expect(methods.json()).toMatchObject({ oauth: { microsoft: true } });
  });

  describe('the first link', () => {
    it('binds a member whose domain Microsoft has verified, by tenant and object id', async () => {
      const lina = await addAgent('lina@acme.test');
      const claims = claimsFor(lina.email);

      const landed = await (await buttonSignIn(claims)).landed();

      expect(landed.pathname).toBe('/oauth/callback');
      expect(landed.searchParams.get('code')).not.toBeNull();
      expect(await identitiesOf(lina.id)).toEqual([
        { provider: 'microsoft', subject: `${TENANT}:${claims.oid}` },
      ]);
      expect(await authRowsOf(lina.id)).toContainEqual({
        action: 'auth.oauth.linked',
        actorType: 'system',
        meta: { provider: 'microsoft', via: 'sign-in' },
      });
    });

    it.each([
      ['an email Microsoft has not verified (no xms_edov)', { xms_edov: undefined }],
      ['an email whose domain is unverified', { xms_edov: false }],
      ['a guest of the tenant, even with a verified domain', { acct: 1 }],
      ['a token that cannot tell a guest from a member', { acct: undefined }],
    ])('refuses %s, binds nothing and asks to connect from a session', async (_why, change) => {
      const omar = await addAgent(`omar-${uuidv7().slice(-6)}@acme.test`);

      const landed = await (await buttonSignIn(claimsFor(omar.email, change))).landed();

      expect(landed.searchParams.get('error')).toBe('oauth-link-required');
      expect(landed.searchParams.get('code')).toBeNull();
      expect(await identitiesOf(omar.id)).toEqual([]);
    });

    it('answers an address nobody holds the same as an address somebody holds', async () => {
      const landed = await (await buttonSignIn(claimsFor('nobody@acme.test'))).landed();

      expect(landed.searchParams.get('error')).toBe('no-account');
      expect(landed.searchParams.get('code')).toBeNull();
    });
  });

  describe('a bound account', () => {
    it('signs in whatever the token says its address is now, without the verified claim', async () => {
      const hala = await addAgent('hala@acme.test');
      const claims = claimsFor(hala.email);
      await (await buttonSignIn(claims)).landed();

      const landed = await (
        await buttonSignIn({
          ...claims,
          email: 'hala.renamed@acme.test',
          xms_edov: undefined,
          acct: undefined,
        })
      ).landed();

      expect(landed.searchParams.get('code')).not.toBeNull();
    });

    it('refuses a second Microsoft account on an address that already has one', async () => {
      const rami = await addAgent('rami@acme.test');
      await (await buttonSignIn(claimsFor(rami.email))).landed();

      const landed = await (await buttonSignIn(claimsFor(rami.email))).landed();

      expect(landed.searchParams.get('error')).toBe('oauth-identity-conflict');
      expect(await identitiesOf(rami.id)).toHaveLength(1);
    });
  });

  describe("a token that is not this install's tenant", () => {
    it("refuses another tenant's issuer, binds nothing and audits it without naming an account", async () => {
      const dina = await addAgent('dina@acme.test');

      const landed = await (
        await buttonSignIn(claimsFor(dina.email, { tid: OTHER_TENANT }), {
          issuer: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
        })
      ).landed();

      expect(landed.searchParams.get('error')).toBe('oauth-tenant-mismatch');
      expect(landed.searchParams.get('code')).toBeNull();
      expect(await identitiesOf(dina.id)).toEqual([]);
      expect(await failuresWithNoAccount()).toContainEqual({
        meta: { method: 'oauth', provider: 'microsoft', reason: 'tenant-mismatch' },
      });
    });

    it("refuses this tenant's issuer carrying another tenant's tid", async () => {
      const sami = await addAgent('sami@acme.test');

      const landed = await (
        await buttonSignIn(claimsFor(sami.email, { tid: OTHER_TENANT }))
      ).landed();

      expect(landed.searchParams.get('error')).toBe('oauth-tenant-mismatch');
      expect(await identitiesOf(sami.id)).toEqual([]);
    });

    it('refuses a token minted for another application', async () => {
      const noor = await addAgent('noor@acme.test');

      const landed = await (
        await buttonSignIn(claimsFor(noor.email), { audience: 'another-client' })
      ).landed();

      expect(landed.searchParams.get('error')).toBe('no-account');
      expect(await identitiesOf(noor.id)).toEqual([]);
    });
  });

  describe('the round trip', () => {
    it('refuses a replayed callback: the state is spent by the first one', async () => {
      const yara = await addAgent('yara@acme.test');
      const flow = await buttonSignIn(claimsFor(yara.email));

      const first = landing(await flow.call());
      const replay = landing(await flow.call());

      expect(first.searchParams.get('code')).not.toBeNull();
      expect(replay.searchParams.get('error')).toBe('no-account');
      expect(replay.searchParams.get('code')).toBeNull();
    });

    it('refuses a callback from a browser that did not start the flow', async () => {
      const lama = await addAgent('lama@acme.test');
      const flow = await buttonSignIn(claimsFor(lama.email));
      const state = flow.authorization.searchParams.get('state') ?? '';

      const response = await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/microsoft/callback?code=c&state=${state}`,
        headers: { cookie: `${nonceCookie.name}=another-browsers-nonce` },
      });

      expect(landing(response).searchParams.get('error')).toBe('no-account');
      expect(await identitiesOf(lama.id)).toEqual([]);
    });

    it('refuses the same state presented to the Google callback', async () => {
      const flow = await buttonSignIn(claimsFor('x@acme.test'));
      const state = flow.authorization.searchParams.get('state') ?? '';

      const response = await app.inject({
        method: 'GET',
        url: `/api/auth/oauth/google/callback?code=c&state=${state}`,
      });

      expect(landing(response).searchParams.get('code')).toBeNull();
    });
  });

  describe('connecting from a session, and accepting an invitation', () => {
    it('connects with the current password, whatever the claims say about the address', async () => {
      const fadi = await addAgent('fadi@acme.test');
      const session = await post('/api/auth/sign-in', { email: fadi.email, password: PASSWORD });
      const accessToken = (session.json() as { accessToken: string }).accessToken;
      const started = await post(
        '/api/auth/oauth/microsoft/connect',
        { currentPassword: PASSWORD },
        accessToken,
      );
      expect(started.statusCode).toBe(201);
      const authorization = new URL((started.json() as { url: string }).url);
      const claims = claimsFor('fadi.work@acme.test', { xms_edov: undefined, acct: undefined });
      nextIdToken = await microsoft.idToken(claims, {
        nonce: authorization.searchParams.get('nonce') ?? '',
      });

      const landed = landing(
        await app.inject({
          method: 'GET',
          url: `/api/auth/oauth/microsoft/callback?code=c&state=${authorization.searchParams.get('state')}`,
          headers: {
            cookie: `${nonceCookie.name}=${started.cookies.find((cookie) => cookie.name === nonceCookie.name)?.value}`,
          },
        }),
      );

      expect(landed.pathname).toBe('/settings/account/security');
      expect(await identitiesOf(fadi.id)).toEqual([
        { provider: 'microsoft', subject: `${TENANT}:${claims.oid}` },
      ]);
    });

    it('accepts an invitation when Microsoft verified the invited address, and refuses another', async () => {
      const nour = await addInvited('nour.invited@acme.test');
      const mismatch = await addInvited('omar.invited@acme.test');
      const accept = async (token: string, claims: Record<string, unknown>) => {
        const started = await post(`/api/auth/invites/${token}/oauth/microsoft`, {
          name: 'Invited',
          locale: 'en',
        });
        expect(started.statusCode).toBe(201);
        const authorization = new URL((started.json() as { url: string }).url);
        nextIdToken = await microsoft.idToken(claims, {
          nonce: authorization.searchParams.get('nonce') ?? '',
        });
        return landing(
          await app.inject({
            method: 'GET',
            url: `/api/auth/oauth/microsoft/callback?code=c&state=${authorization.searchParams.get('state')}`,
            headers: {
              cookie: `${nonceCookie.name}=${started.cookies.find((cookie) => cookie.name === nonceCookie.name)?.value}`,
            },
          }),
        );
      };

      const accepted = await accept(nour.token, claimsFor('nour.invited@acme.test'));
      const refused = await accept(mismatch.token, claimsFor('someone.else@acme.test'));
      const unverified = await accept(
        mismatch.token,
        claimsFor('omar.invited@acme.test', { xms_edov: undefined }),
      );

      expect(accepted.searchParams.get('code')).not.toBeNull();
      expect(await identitiesOf(nour.id)).toHaveLength(1);
      expect(refused.searchParams.get('error')).toBe('oauth-invite-mismatch');
      expect(unverified.searchParams.get('error')).toBe('oauth-invite-mismatch');
      expect(await identitiesOf(mismatch.id)).toEqual([]);
    });
  });
  describe('changing the tenant, or switching personal accounts off', () => {
    const NEW_TENANT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';

    const asInstallAdmin = () => ({
      [DEV_PRINCIPAL_HEADER]: JSON.stringify({
        type: 'staff',
        id: seeded.userId,
        brands: {},
        installAdmin: true,
      }),
    });

    const saveMicrosoft = (tenantId: string, allowConsumers?: boolean) =>
      devApp.inject({
        method: 'PUT',
        url: '/api/install/settings/authentication',
        headers: asInstallAdmin(),
        payload: {
          requireTwoFactor: false,
          magicLinkValidityMinutes: 10,
          google: { clientId: '' },
          microsoft: {
            clientId: 'client-id',
            tenantId,
            ...(allowConsumers === undefined ? {} : { allowConsumers }),
          },
          github: { clientId: '' },
        },
      });

    const replacedRows = (userId: string) =>
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
            .select({ meta: auditLog.meta })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, 'auth.oauth.identity_replaced'),
                eq(auditLog.targetId, userId),
              ),
            ),
      );

    /** Binds `address` under the suite's tenant, then moves the install to NEW_TENANT. */
    const strandedUnder = async (address: string) => {
      const person = await addAgent(address);
      const claims = claimsFor(address);
      await (await buttonSignIn(claims)).landed();
      expect(await identitiesOf(person.id)).toHaveLength(1);
      expect((await saveMicrosoft(NEW_TENANT)).statusCode).toBe(200);
      microsoft = await createFakeMicrosoft({ tenantId: NEW_TENANT });
      return { person, claims };
    };

    const restoreSuiteTenant = async () => {
      await saveMicrosoft(TENANT);
      microsoft = await createFakeMicrosoft({ tenantId: TENANT });
    };

    it("leaves the old identity in place after a tenant change, and turns the old tenant's tokens away", async () => {
      const { person, claims } = await strandedUnder('lina.stranded@acme.test');

      expect(await identitiesOf(person.id)).toEqual([
        { provider: 'microsoft', subject: `${TENANT}:${claims.oid}` },
      ]);
      const old = await (await buttonSignIn(claims)).landed();
      expect(old.searchParams.get('error')).toBe('oauth-tenant-mismatch');
      expect(old.searchParams.get('code')).toBeNull();

      await restoreSuiteTenant();
    });

    it('replaces it at a first link in the new tenant, with an audit row and the email', async () => {
      const { person, claims } = await strandedUnder('omar.replaced@acme.test');
      await email.clear();
      const fresh = { ...claims, tid: NEW_TENANT, oid: uuidv7() };

      const landed = await (await buttonSignIn(fresh)).landed();

      expect(landed.searchParams.get('code')).not.toBeNull();
      expect(await identitiesOf(person.id)).toEqual([
        { provider: 'microsoft', subject: `${NEW_TENANT}:${fresh.oid}` },
      ]);
      expect(await replacedRows(person.id)).toEqual([
        {
          meta: {
            provider: 'microsoft',
            via: 'sign-in',
            fromTenant: TENANT,
            toTenant: NEW_TENANT,
          },
        },
      ]);
      expect(
        (await email.all()).filter(
          (message) => message.to.address === person.email && message.text.includes('Microsoft'),
        ).length,
      ).toBeGreaterThan(0);

      await restoreSuiteTenant();
    });

    it('replaces it when they connect from a session', async () => {
      const { person } = await strandedUnder('hala.connect@acme.test');
      const session = await post('/api/auth/sign-in', { email: person.email, password: PASSWORD });
      const accessToken = (session.json() as { accessToken: string }).accessToken;
      const started = await post(
        '/api/auth/oauth/microsoft/connect',
        { currentPassword: PASSWORD },
        accessToken,
      );
      expect(started.statusCode).toBe(201);
      const authorization = new URL((started.json() as { url: string }).url);
      const next = claimsFor(person.email, { tid: NEW_TENANT, xms_edov: undefined });
      nextIdToken = await microsoft.idToken(next, {
        nonce: authorization.searchParams.get('nonce') ?? '',
      });

      const landed = landing(
        await app.inject({
          method: 'GET',
          url: `/api/auth/oauth/microsoft/callback?code=c&state=${authorization.searchParams.get('state')}`,
          headers: {
            cookie: `${nonceCookie.name}=${started.cookies.find((cookie) => cookie.name === nonceCookie.name)?.value}`,
          },
        }),
      );

      expect(landed.pathname).toBe('/settings/account/security');
      expect(await identitiesOf(person.id)).toEqual([
        { provider: 'microsoft', subject: `${NEW_TENANT}:${next.oid}` },
      ]);
      expect((await replacedRows(person.id))[0]?.meta).toMatchObject({ via: 'connect' });

      await restoreSuiteTenant();
    });

    it('rolls the replacement back whole when anything in it fails', async () => {
      const { person, claims } = await strandedUnder('rami.rollback@acme.test');
      const repository = new OauthIdentityRepository({ db: runtime.db });
      // What the boot warning counts: stranded rows, read and never written.
      expect(await repository.countMicrosoftOutside([NEW_TENANT])).toBeGreaterThan(0);
      expect(await repository.countMicrosoftOutside([])).toBe(0);
      const [membership] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(userBrandRoles).where(eq(userBrandRoles.userId, person.id)),
      );

      await expect(
        repository.replaceStrandedMicrosoft({
          link: {
            userId: person.id,
            provider: 'microsoft',
            subject: `${NEW_TENANT}:${uuidv7()}`,
            email: person.email,
            via: 'sign-in',
          },
          acceptedTenants: [NEW_TENANT],
          brandId: membership?.brandId ?? seeded.brandId,
          afterReplace: () => Promise.reject(new Error('the outbox write failed')),
        }),
      ).rejects.toThrow('the outbox write failed');

      expect(await identitiesOf(person.id)).toEqual([
        { provider: 'microsoft', subject: `${TENANT}:${claims.oid}` },
      ]);
      expect(await replacedRows(person.id)).toEqual([]);

      await restoreSuiteTenant();
    });

    it('does not lock out a person whose only sign-in method is Microsoft', async () => {
      const id = uuidv7();
      const address = 'sami.only@acme.test';
      await runtime.db
        .insert(users)
        .values({ id, email: address, name: address, status: 'active' });
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .insert(userBrandRoles)
          .values({ userId: id, brandId: seeded.brandId, role: 'agent', departmentIds: [] }),
      );
      const claims = claimsFor(address);
      await (await buttonSignIn(claims)).landed();
      expect(await identitiesOf(id)).toHaveLength(1);
      expect((await saveMicrosoft(NEW_TENANT)).statusCode).toBe(200);
      microsoft = await createFakeMicrosoft({ tenantId: NEW_TENANT });

      const landed = await (
        await buttonSignIn({ ...claims, tid: NEW_TENANT, oid: uuidv7() })
      ).landed();

      expect(landed.searchParams.get('code')).not.toBeNull();
      expect(await identitiesOf(id)).toHaveLength(1);

      await restoreSuiteTenant();
    });

    it('accepts a personal account only to connect, and stops accepting it when they are switched off', async () => {
      expect((await saveMicrosoft(TENANT, true)).statusCode).toBe(200);
      microsoft = await createFakeMicrosoft({ tenantId: TENANT, common: true });
      const nour = await addAgent('nour.personal@acme.test');
      const personal = {
        tid: CONSUMERS,
        // A personal account's object id is zero-padded, so it is a GUID but not an RFC 9562 UUID.
        oid: '00000000-0000-0000-66f3-3332eca7ea81',
        email: nour.email,
        // Even with the claims that vouch for a member, a personal account never links by address.
        xms_edov: true,
        acct: 0,
      };

      const refused = await (await buttonSignIn(personal)).landed();
      expect(refused.searchParams.get('error')).toBe('oauth-link-required');
      expect(await identitiesOf(nour.id)).toEqual([]);

      const session = await post('/api/auth/sign-in', { email: nour.email, password: PASSWORD });
      const accessToken = (session.json() as { accessToken: string }).accessToken;
      const started = await post(
        '/api/auth/oauth/microsoft/connect',
        { currentPassword: PASSWORD },
        accessToken,
      );
      const authorization = new URL((started.json() as { url: string }).url);
      expect(authorization.pathname).toBe('/common/oauth2/v2.0/authorize');
      nextIdToken = await microsoft.idToken(personal, {
        nonce: authorization.searchParams.get('nonce') ?? '',
      });
      const connected = landing(
        await app.inject({
          method: 'GET',
          url: `/api/auth/oauth/microsoft/callback?code=c&state=${authorization.searchParams.get('state')}`,
          headers: {
            cookie: `${nonceCookie.name}=${started.cookies.find((cookie) => cookie.name === nonceCookie.name)?.value}`,
          },
        }),
      );
      expect(connected.pathname).toBe('/settings/account/security');
      expect(await identitiesOf(nour.id)).toEqual([
        { provider: 'microsoft', subject: `${CONSUMERS}:${personal.oid}` },
      ]);

      // Bound, it signs in; a work tenant that is not the pinned one is still refused.
      const signedIn = await (
        await buttonSignIn({ ...personal, email: 'renamed@outlook.test' })
      ).landed();
      expect(signedIn.searchParams.get('code')).not.toBeNull();
      const stranger = await (
        await buttonSignIn(claimsFor('x@acme.test', { tid: OTHER_TENANT }), {
          issuer: microsoft.issuer,
        })
      ).landed();
      expect(stranger.searchParams.get('error')).toBe('oauth-tenant-mismatch');

      // Switched off, the row stays but its tenant is no longer accepted.
      expect((await saveMicrosoft(TENANT, false)).statusCode).toBe(200);
      microsoft = await createFakeMicrosoft({ tenantId: TENANT, common: false });
      expect(await identitiesOf(nour.id)).toHaveLength(1);
      const turnedAway = await (await buttonSignIn(personal)).landed();
      expect(turnedAway.searchParams.get('error')).toBe('oauth-tenant-mismatch');
    });
  });
});
