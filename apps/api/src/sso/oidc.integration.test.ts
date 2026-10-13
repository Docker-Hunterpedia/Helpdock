import 'reflect-metadata';
import { createKeyring, encryptSecret } from '@helpdock/config';
import {
  brands,
  createDb,
  type DbHandle,
  ssoConnections,
  userBrandRoles,
  userSsoIdentities,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { fakeOidcIdp } from '../testing/fake-oidc-idp.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { silentLogger } from '../testing/silent-logger.js';
import { OidcService } from './oidc.service.js';

const USER = uuidv7();
const BRAND = uuidv7();
const CONNECTION = uuidv7();
const KEY = Buffer.alloc(32, 87).toString('base64');

describe.skipIf(!hasDocker)('M11-02 OIDC through Postgres, Redis and a local IdP', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let idp: Awaited<ReturnType<typeof fakeOidcIdp>>;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  const service = () => app.get(OidcService);

  beforeAll(async () => {
    [postgres, redis, idp] = await Promise.all([startPostgres(), startRedis(), fakeOidcIdp()]);
    const env = metaEnv({
      masterKey: KEY,
      postgres,
      redis,
      graph: { facebookRoot: idp.issuer, instagramRoot: idp.issuer },
    });
    runtime = await createRuntime({ env, logger: silentLogger() });
    owner = createDb({ url: postgres.getConnectionUri() });
    await runtime.db.insert(brands).values({ id: BRAND, name: 'OIDC Brand', prefix: 'OIDC' });
    await runtime.db
      .insert(users)
      .values({ id: USER, email: 'ada@example.com', name: 'Ada', status: 'active' });
    await withSystem(runtime.db, BRAND, (tx) =>
      tx.insert(userBrandRoles).values({ userId: USER, brandId: BRAND, role: 'viewer' }),
    );
    app = await createApiApp({ runtime });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 300000);

  beforeEach(async () => {
    idp.reset();
    await runtime.redis.flushdb();
    await owner.db
      .update(users)
      .set({ status: 'active', totpEnabled: false, totpSecretEncrypted: null })
      .where(eq(users.id, USER));
    await owner.db.delete(userSsoIdentities);
    await owner.db.delete(ssoConnections);
    await owner.db.insert(ssoConnections).values({
      id: CONNECTION,
      name: 'Work',
      protocol: 'oidc',
      enabled: true,
      emailDomains: ['example.com'],
      groupAttribute: 'groups',
      createdBy: USER,
      config: ssoConnectionConfigSchema.parse({
        protocol: 'oidc',
        issuer: idp.issuer,
        clientId: 'helpdock',
      }),
      secretEncrypted: encryptSecret('test-secret', createKeyring({ APP_MASTER_KEY: KEY })),
    });
    await owner.db.insert(userSsoIdentities).values({
      connectionId: CONNECTION,
      userId: USER,
      subject: 'staff-1',
      emailAtLink: 'ada@example.com',
    });
  });

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await idp?.close();
    await redis?.stop();
    await postgres?.stop();
  });

  const flow = async () => {
    const started = await service().start({
      connectionId: CONNECTION,
      returnTo: '/tickets',
      ip: 'test-ip',
    });
    // Fixed local stand-in, never user input or a live provider.
    const response = await fetch(started.url, { redirect: 'manual' });
    const callback = new URL(response.headers.get('location') ?? '');
    const query = {
      state: callback.searchParams.get('state') ?? '',
      code: callback.searchParams.get('code') ?? '',
    };
    return { started, query };
  };
  const complete = (attempt: Awaited<ReturnType<typeof flow>>) =>
    service().complete({
      connectionId: CONNECTION,
      query: attempt.query,
      browserNonce: attempt.started.browserNonce,
      ip: 'test-ip',
    });

  it('validates a signed identity, mapped groups and a PKCE-bound code', async () => {
    const attempt = await flow();
    expect(await complete(attempt)).toEqual({
      assertion: {
        connectionId: CONNECTION,
        subject: 'staff-1',
        email: 'ada@example.com',
        emailVerified: true,
        name: 'Ada',
        groups: ['Support'],
      },
      returnTo: '/tickets',
    });
    expect(idp.requests.some((request) => request.path === '/jwks')).toBe(true);
  });

  it.each(['badSignature', 'expired', 'wrongIssuer', 'wrongNonce', 'wrongAudience'] as const)(
    'refuses ID token attack %s',
    async (attack) => {
      const attempt = await flow();
      idp.controls[attack] = true;
      await expect(complete(attempt)).rejects.toThrow('sso-token-invalid');
    },
  );

  it('refuses unverified email even when UserInfo supplies another identity', async () => {
    const attempt = await flow();
    idp.controls.claims.email_verified = false;
    await expect(complete(attempt)).rejects.toThrow('sso-email-unverified');
  });

  it('consumes state atomically across concurrent callbacks', async () => {
    const attempt = await flow();
    const results = await Promise.allSettled([complete(attempt), complete(attempt)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects a wrong browser and leaves its state spent', async () => {
    const attempt = await flow();
    await expect(
      service().complete({
        connectionId: CONNECTION,
        query: attempt.query,
        browserNonce: 'attacker',
        ip: 'test-ip',
      }),
    ).rejects.toThrow('sso-request-invalid');
    await expect(complete(attempt)).rejects.toThrow('sso-request-invalid');
    expect(idp.requests.some((request) => request.path === '/token')).toBe(false);
  });

  it('refuses configuration changes and disabling during a round trip', async () => {
    const attempt = await flow();
    await owner.db
      .update(ssoConnections)
      .set({ groupAttribute: 'roles' })
      .where(eq(ssoConnections.id, CONNECTION));
    await expect(complete(attempt)).rejects.toThrow('sso-configuration-changed');
    await owner.db
      .update(ssoConnections)
      .set({ enabled: false })
      .where(eq(ssoConnections.id, CONNECTION));
    await expect(
      service().start({ connectionId: CONNECTION, returnTo: '/', ip: 'test-ip' }),
    ).rejects.toThrow('sso-connection-disabled');
  });

  it('does not follow token redirects or forward secrets to another endpoint', async () => {
    const attempt = await flow();
    idp.controls.tokenRedirect = true;
    await expect(complete(attempt)).rejects.toThrow('sso-token-invalid');
    expect(idp.requests.some((request) => request.path === '/credential-leak')).toBe(false);
  });

  it('refuses private discovered JWKS destinations before token exchange', async () => {
    idp.controls.privateJwks = true;
    // A distinct configuration revision invalidates any previous cached discovery.
    await owner.db
      .update(ssoConnections)
      .set({ name: 'Private JWKS' })
      .where(eq(ssoConnections.id, CONNECTION));
    await expect(
      service().start({ connectionId: CONNECTION, returnTo: '/', ip: 'test-ip' }),
    ).rejects.toThrow();
    expect(idp.requests.some((request) => request.path === '/token')).toBe(false);
  });

  it('fails closed on unresolved group overage without attempting its URL', async () => {
    const attempt = await flow();
    idp.controls.claims._claim_names = { groups: 'src1' };
    idp.controls.claims._claim_sources = { src1: { endpoint: 'http://169.254.169.254/groups' } };
    await expect(complete(attempt)).rejects.toThrow('sso-groups-unavailable');
  });

  it('supplements profile data only from subject-matched UserInfo', async () => {
    const attempt = await flow();
    delete idp.controls.claims.name;
    delete idp.controls.claims.groups;
    expect((await complete(attempt)).assertion).toMatchObject({
      name: 'Ada UserInfo',
      groups: ['Support'],
      email: 'ada@example.com',
    });
    const wrong = await flow();
    idp.controls.userInfoSubject = 'another-user';
    await expect(complete(wrong)).rejects.toThrow('sso-token-invalid');
  });

  it('bounds start attempts across replicas', async () => {
    for (let index = 0; index < 20; index++)
      await service().start({ connectionId: CONNECTION, returnTo: '/', ip: 'rate-test' });
    await expect(
      service().start({ connectionId: CONNECTION, returnTo: '/', ip: 'rate-test' }),
    ).rejects.toThrow('sso-rate-limited');
  });

  it('hands a pre-linked account to a refresh cookie and one-time exchange code over HTTP', async () => {
    const start = await app.inject({
      method: 'GET',
      url: `/api/auth/sso/${CONNECTION}/start?returnTo=/tickets`,
    });
    expect(start.statusCode).toBe(302);
    const cookie = start.cookies[0];
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    const authorize = await fetch(String(start.headers.location), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const result = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      cookies: { [cookie?.name ?? '']: cookie?.value ?? '' },
    });
    expect(result.statusCode).toBe(302);
    const landing = new URL(String(result.headers.location));
    expect(landing.pathname).toBe('/sign-in/complete');
    expect(landing.searchParams.has('code')).toBe(true);
    expect(result.cookies.some((value) => value.name.includes('hd_refresh'))).toBe(true);
    const exchange = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code: landing.searchParams.get('code') },
    });
    expect(exchange.statusCode).toBe(201);
    expect(exchange.json().session.user.id).toBe(USER);
    expect(JSON.stringify(exchange.json())).not.toContain('test-secret');
  });

  it('redirects HTTP start and callback failures without issuing a session', async () => {
    const start = await app.inject({ method: 'GET', url: `/api/auth/sso/${CONNECTION}/start` });
    const authorize = await fetch(String(start.headers.location), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const refused = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
    });
    expect(refused.statusCode).toBe(302);
    expect(new URL(String(refused.headers.location)).searchParams.get('error')).toBe('unavailable');
    expect(refused.cookies.some((cookie) => cookie.name.includes('hd_refresh'))).toBe(false);
    await owner.db
      .update(ssoConnections)
      .set({ enabled: false })
      .where(eq(ssoConnections.id, CONNECTION));
    const disabled = await app.inject({ method: 'GET', url: `/api/auth/sso/${CONNECTION}/start` });
    expect(new URL(String(disabled.headers.location)).searchParams.get('error')).toBe(
      'unavailable',
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/auth/sso/${CONNECTION}/start?returnTo=//evil.example`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/api/auth/sso/${CONNECTION}/start?test=1` }))
        .statusCode,
    ).toBe(400);
  });

  it('keeps local TOTP challenges on the HTTP SSO path', async () => {
    await owner.db
      .update(users)
      .set({
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(
          'fixture-totp-secret',
          createKeyring({ APP_MASTER_KEY: KEY }),
        ),
      })
      .where(eq(users.id, USER));
    const start = await app.inject({ method: 'GET', url: `/api/auth/sso/${CONNECTION}/start` });
    const cookie = start.cookies[0];
    const authorize = await fetch(String(start.headers.location), { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location') ?? '');
    const response = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      cookies: { [cookie?.name ?? '']: cookie?.value ?? '' },
    });
    const landing = new URL(String(response.headers.location));
    expect(landing.searchParams.has('challenge')).toBe(true);
    expect(landing.searchParams.has('code')).toBe(false);
    expect(response.cookies.some((value) => value.name.includes('hd_refresh'))).toBe(false);
  });

  it('never links an unknown subject by email before M11-04 provisions it', async () => {
    await owner.db.delete(userSsoIdentities);
    const assertion = (await complete(await flow())).assertion;
    const { AuthService } = await import('../auth/auth.service.js');
    await expect(app.get(AuthService).completeSso(assertion, undefined)).rejects.toMatchObject({
      auth: { code: 'no-account' },
    });
  });
});
