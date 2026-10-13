import 'reflect-metadata';
import {
  auditLog,
  brands,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
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
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { fakeSamlIdp } from '../testing/fake-saml-idp.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { silentLogger } from '../testing/silent-logger.js';
import { SamlService } from './saml.service.js';
import { createSamlMetadataProcessor, refreshSamlMetadata } from './saml-metadata.job.js';
import { SAML_METADATA_NS, samlChild, samlChildren, samlDocument } from './saml-xml.js';
import { SsoService } from './sso.service.js';

const USER = uuidv7();
const BRAND = uuidv7();
const CONNECTION = uuidv7();
const KEY = Buffer.alloc(32, 89).toString('base64');

describe.skipIf(!hasDocker)('M11-03 SAML through Postgres, Redis and a signed local IdP', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let idp: Awaited<ReturnType<typeof fakeSamlIdp>>;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  const service = () => app.get(SamlService);
  const recipient = () =>
    new URL(`/api/auth/sso/${CONNECTION}/saml/acs`, runtime.env.APP_URL).toString();
  const audience = () => new URL('/api/auth/sso/saml/metadata', runtime.env.APP_URL).toString();
  beforeAll(async () => {
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';
    [postgres, redis, idp] = await Promise.all([startPostgres(), startRedis(), fakeSamlIdp()]);
    runtime = await createRuntime({
      env: metaEnv({
        masterKey: KEY,
        postgres,
        redis,
        graph: { facebookRoot: idp.issuer, instagramRoot: idp.issuer },
      }),
      logger: silentLogger(),
    });
    owner = createDb({ url: postgres.getConnectionUri() });
    await runtime.db.insert(brands).values({ id: BRAND, name: 'SAML Brand', prefix: 'SAML' });
    await runtime.db
      .insert(users)
      .values({ id: USER, email: 'ada@example.com', name: 'Ada', status: 'active' });
    await withSystem(runtime.db, BRAND, (tx) =>
      tx.insert(userBrandRoles).values({ userId: USER, brandId: BRAND, role: 'viewer' }),
    );
    app = await createApiApp({ runtime });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    idp.controls.spCertificate = (await app.get(SsoService).spKeys()).certificate;
  }, 300000);
  beforeEach(async () => {
    idp.reset();
    await runtime.redis.flushdb();
    await owner.db.delete(userSsoIdentities);
    await owner.db.delete(ssoConnections);
    await owner.db.insert(ssoConnections).values({
      id: CONNECTION,
      name: 'Work',
      protocol: 'saml',
      enabled: true,
      emailDomains: ['example.com'],
      groupAttribute: 'groups',
      createdBy: USER,
      config: ssoConnectionConfigSchema.parse({
        protocol: 'saml',
        idpEntityId: idp.issuer,
        idpSsoUrl: `${idp.issuer}/sso`,
        idpCertificates: [idp.certificate],
        emailAttribute: 'email',
        nameAttribute: 'name',
      }),
    });
    await owner.db.insert(userSsoIdentities).values({
      connectionId: CONNECTION,
      userId: USER,
      subject: 'staff-1',
      emailAtLink: 'ada@example.com',
    });
  });
  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await idp?.close();
    await redis?.stop();
    await postgres?.stop();
  });
  const connectionRow = async () => {
    const [row] = await owner.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, CONNECTION));
    if (!row) throw new Error('Missing SAML connection fixture');
    return row;
  };
  const start = () =>
    service().start({ connectionId: CONNECTION, returnTo: '/tickets', ip: 'test-ip' });
  const flow = async () => {
    const started = await start();
    return { started, body: idp.authorize(started.url) };
  };
  const accept = (body: unknown) =>
    service().accept({ connectionId: CONNECTION, body, ip: 'test-ip' });
  const complete = (token: string, nonce: string | undefined) =>
    service().complete({ connectionId: CONNECTION, token, browserNonce: nonce, ip: 'test-ip' });
  const bodyOf = (body: ReturnType<typeof idp.authorize>) => ({
    SAMLResponse: body.SAMLResponse,
    RelayState: body.RelayState,
  });
  const enableInitiated = async () => {
    const row = await connectionRow();
    await owner.db
      .update(ssoConnections)
      .set({ config: { ...row.config, allowIdpInitiated: true } })
      .where(eq(ssoConnections.id, CONNECTION));
  };

  it('signs AuthnRequests and validates identity through the browser-bound completion bridge', async () => {
    const attempt = await flow();
    const accepted = await accept(bodyOf(attempt.body));
    expect(accepted.kind).toBe('pending');
    if (accepted.kind !== 'pending') throw new Error('Expected pending response');
    expect(await complete(accepted.token, attempt.started.browserNonce)).toEqual({
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
    await expect(complete(accepted.token, attempt.started.browserNonce)).rejects.toThrow(
      'sso-request-invalid',
    );
  });
  it.each([
    'unsigned',
    'unknownCert',
    'wrongIssuer',
    'wrongAudience',
    'wrongRecipient',
    'expired',
    'future',
    'missingTimes',
    'missingGroups',
    'duplicateAttribute',
    'wrapping',
  ] as const)('refuses %s assertions', async (control) => {
    idp.controls[control] = true;
    const attempt = await flow();
    await expect(accept(bodyOf(attempt.body))).rejects.toThrow();
  });
  it('accepts explicitly empty authoritative groups instead of treating them as missing', async () => {
    idp.controls.groups = [];
    const attempt = await flow();
    const accepted = await accept(bodyOf(attempt.body));
    if (accepted.kind !== 'pending') throw new Error('Expected pending response');
    expect((await complete(accepted.token, attempt.started.browserNonce)).assertion.groups).toEqual(
      [],
    );
  });
  it('refuses altered signed attributes and DTDs', async () => {
    const attempt = await flow();
    const xml = Buffer.from(attempt.body.SAMLResponse, 'base64')
      .toString()
      .replace('staff-1', 'attacker');
    await expect(
      accept({ ...bodyOf(attempt.body), SAMLResponse: Buffer.from(xml).toString('base64') }),
    ).rejects.toThrow();
    await expect(
      accept({
        SAMLResponse: Buffer.from(
          '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>',
        ).toString('base64'),
      }),
    ).rejects.toThrow();
  });
  it('refuses a domain not authorized by the connection', async () => {
    idp.controls.email = 'ada@attacker.example';
    const attempt = await flow();
    await expect(accept(bodyOf(attempt.body))).rejects.toThrow('sso-email-unverified');
  });
  it('admits at most one concurrent POST and one concurrent completion', async () => {
    const attempt = await flow();
    const accepted = await Promise.allSettled([
      accept(bodyOf(attempt.body)),
      accept(bodyOf(attempt.body)),
    ]);
    expect(accepted.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const first = accepted.find((outcome) => outcome.status === 'fulfilled');
    if (first?.status !== 'fulfilled' || first.value.kind !== 'pending')
      throw new Error('Expected pending response');
    const completed = await Promise.allSettled([
      complete(first.value.token, attempt.started.browserNonce),
      complete(first.value.token, attempt.started.browserNonce),
    ]);
    expect(completed.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });
  it('refuses a wrong browser and burns the handoff', async () => {
    const attempt = await flow();
    const accepted = await accept(bodyOf(attempt.body));
    if (accepted.kind !== 'pending') throw new Error('Expected pending response');
    await expect(complete(accepted.token, 'wrong-browser')).rejects.toThrow('sso-request-invalid');
    await expect(complete(accepted.token, attempt.started.browserNonce)).rejects.toThrow(
      'sso-request-invalid',
    );
  });
  it('refuses swapped RelayState, expired request cache and mismatched signed correlation', async () => {
    const first = await flow();
    const second = await flow();
    const accepted = await accept({ ...bodyOf(first.body), RelayState: second.body.RelayState });
    if (accepted.kind !== 'pending') throw new Error('Expected pending response');
    await expect(complete(accepted.token, second.started.browserNonce)).rejects.toThrow(
      'sso-request-invalid',
    );
    await runtime.redis.flushdb();
    await expect(accept(bodyOf(second.body))).rejects.toThrow();
  });
  it.each(['disabled', 'changed'] as const)(
    'refuses %s connections before completion',
    async (change) => {
      const attempt = await flow();
      const accepted = await accept(bodyOf(attempt.body));
      if (accepted.kind !== 'pending') throw new Error('Expected pending response');
      await owner.db
        .update(ssoConnections)
        .set(
          change === 'disabled' ? { enabled: false } : { updatedAt: new Date(Date.now() + 10000) },
        )
        .where(eq(ssoConnections.id, CONNECTION));
      await expect(complete(accepted.token, attempt.started.browserNonce)).rejects.toThrow();
    },
  );
  it('accepts both configured certificates during rotation', async () => {
    const row = await connectionRow();
    await owner.db
      .update(ssoConnections)
      .set({
        config: { ...row.config, idpCertificates: [idp.certificate, idp.rotatedCertificate] },
      })
      .where(eq(ssoConnections.id, CONNECTION));
    for (const rotated of [false, true]) {
      idp.controls.rotated = rotated;
      const attempt = await flow();
      expect((await accept(bodyOf(attempt.body))).kind).toBe('pending');
    }
  });
  it('refuses unsolicited responses by default', async () => {
    await expect(
      accept({ SAMLResponse: idp.response({ recipient: recipient(), audience: audience() }) }),
    ).rejects.toThrow();
  });
  it('opted-in IdP initiation requires a browser-bound SP round trip for the same subject', async () => {
    await enableInitiated();
    const body = { SAMLResponse: idp.response({ recipient: recipient(), audience: audience() }) };
    const accepted = await accept(body);
    expect(accepted.kind).toBe('challenge');
    await expect(accept(body)).rejects.toThrow('sso-replay-refused');
    if (accepted.kind !== 'challenge') throw new Error('Expected fresh SP challenge');
    const pending = await accept(bodyOf(idp.authorize(accepted.url)));
    if (pending.kind !== 'pending') throw new Error('Expected pending response');
    expect((await complete(pending.token, accepted.browserNonce)).assertion.subject).toBe(
      'staff-1',
    );
  });
  it('refuses a different subject after IdP initiation', async () => {
    await enableInitiated();
    const accepted = await accept({
      SAMLResponse: idp.response({ recipient: recipient(), audience: audience() }),
    });
    if (accepted.kind !== 'challenge') throw new Error('Expected challenge');
    idp.controls.subject = 'different-user';
    const pending = await accept(bodyOf(idp.authorize(accepted.url)));
    if (pending.kind !== 'pending') throw new Error('Expected pending response');
    await expect(complete(pending.token, accepted.browserNonce)).rejects.toThrow(
      'sso-subject-invalid',
    );
  });
  it('publishes one install entity, signing/encryption certificates and every enabled ACS', async () => {
    const otherId = uuidv7();
    const row = await connectionRow();
    await owner.db.insert(ssoConnections).values({ ...row, id: otherId, name: 'Other SAML' });
    const xml = await service().metadata('test-ip');
    const root = samlDocument(xml).documentElement;
    expect(root.getAttribute('entityID')).toBe(audience());
    const descriptor = samlChild(root, SAML_METADATA_NS, 'SPSSODescriptor');
    expect(descriptor.getAttribute('AuthnRequestsSigned')).toBe('true');
    expect(descriptor.getAttribute('WantAssertionsSigned')).toBe('true');
    expect(
      samlChildren(descriptor, SAML_METADATA_NS, 'AssertionConsumerService').map((node) =>
        node.getAttribute('Location'),
      ),
    ).toEqual(
      expect.arrayContaining([
        recipient(),
        new URL(`/api/auth/sso/${otherId}/saml/acs`, runtime.env.APP_URL).toString(),
      ]),
    );
    expect(samlChildren(descriptor, SAML_METADATA_NS, 'KeyDescriptor')).toHaveLength(2);
  });
  it('decrypts a signed AES-GCM assertion and still refuses unsigned plaintext', async () => {
    const started = await start();
    const issued = idp.authorize(started.url);
    const encrypted = await idp.encryptedResponse(
      { requestId: issued.requestId, recipient: recipient(), audience: audience() },
      idp.controls.spCertificate,
    );
    const accepted = await accept({ SAMLResponse: encrypted, RelayState: issued.RelayState });
    expect(accepted.kind).toBe('pending');
    idp.controls.unsigned = true;
    const second = await start();
    const other = idp.authorize(second.url);
    await expect(
      accept({
        SAMLResponse: await idp.encryptedResponse(
          { requestId: other.requestId, recipient: recipient(), audience: audience() },
          idp.controls.spCertificate,
        ),
        RelayState: other.RelayState,
      }),
    ).rejects.toThrow();
  });
  it('validates metadata on save and applies overlapping rotation on the daily job', async () => {
    const config = ssoConnectionConfigSchema.parse({
      protocol: 'saml',
      idpEntityId: idp.issuer,
      idpSsoUrl: `${idp.issuer}/sso`,
      idpMetadataUrl: `${idp.issuer}/metadata`,
      idpCertificates: [idp.certificate],
      emailAttribute: 'email',
    });
    const http = app.getHttpAdapter().getInstance();
    const saved = await http.inject({
      method: 'PUT',
      url: `/api/install/sso/connections/${CONNECTION}`,
      headers: {
        [DEV_PRINCIPAL_HEADER]: JSON.stringify({
          type: 'staff',
          id: USER,
          installAdmin: true,
          brands: {},
        }),
      },
      payload: { name: 'Work', enabled: true, emailDomains: ['example.com'], config },
    });
    expect(saved.statusCode).toBe(200);
    idp.controls.metadataCertificates = [idp.certificate, idp.rotatedCertificate];
    const processor = createSamlMetadataProcessor({
      db: runtime.db,
      allowCidrs: runtime.env.OUTBOUND_ALLOW_CIDRS,
      log: silentLogger(),
    });
    await processor({ name: 'sso.metadata_refresh', data: {} });
    const row = await connectionRow();
    expect((row.config as { idpCertificates: string[] }).idpCertificates).toHaveLength(2);
    const before = row.updatedAt;
    await processor({ name: 'sso.metadata_refresh', data: {} });
    const repeated = await connectionRow();
    expect(repeated.updatedAt).toEqual(before);
  });
  it('keeps trusted certificates when metadata removes every current certificate, and records an audit warning', async () => {
    const row = await connectionRow();
    await owner.db
      .update(ssoConnections)
      .set({ config: { ...row.config, idpMetadataUrl: `${idp.issuer}/metadata` } })
      .where(eq(ssoConnections.id, CONNECTION));
    idp.controls.metadataCertificates = [idp.rotatedCertificate];
    await refreshSamlMetadata({
      db: runtime.db,
      allowCidrs: runtime.env.OUTBOUND_ALLOW_CIDRS,
      log: silentLogger(),
    });
    const unchanged = await connectionRow();
    expect((unchanged.config as { idpCertificates: string[] }).idpCertificates).toEqual([
      idp.certificate,
    ]);
    const rows = await withSystem(owner.db, INSTALL_SCOPE_BRAND_ID, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'sso.metadata.rotation-refused')),
    );
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.meta)).toEqual([{ reason: 'admin-confirmation-required' }]);
  });
  it('records sanitized metadata failures and continues without replacing certificates', async () => {
    const row = await connectionRow();
    await owner.db
      .update(ssoConnections)
      .set({ config: { ...row.config, idpMetadataUrl: `${idp.issuer}/metadata` } })
      .where(eq(ssoConnections.id, CONNECTION));
    idp.controls.metadataStatus = 500;
    await refreshSamlMetadata({
      db: runtime.db,
      allowCidrs: runtime.env.OUTBOUND_ALLOW_CIDRS,
      log: silentLogger(),
    });
    const unchanged = await connectionRow();
    expect((unchanged.config as { idpCertificates: string[] }).idpCertificates).toEqual([
      idp.certificate,
    ]);
  });
  it('accepts a cross-site form POST without cookies, then binds the local GET before issuing a session', async () => {
    const http = app.getHttpAdapter().getInstance();
    const started = await http.inject({ method: 'GET', url: `/api/auth/sso/${CONNECTION}/start` });
    expect(started.statusCode).toBe(302);
    const issued = idp.authorize(String(started.headers.location));
    const posted = await http.inject({
      method: 'POST',
      url: `/api/auth/sso/${CONNECTION}/saml/acs`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
      payload: new URLSearchParams(bodyOf(issued)).toString(),
    });
    expect(posted.statusCode).toBe(303);
    expect(posted.cookies.some((cookie) => cookie.name.includes('refresh'))).toBe(false);
    const location = new URL(String(posted.headers.location));
    const cookie = started.cookies[0];
    if (!cookie) throw new Error('Missing nonce cookie');
    const completed = await http.inject({
      method: 'GET',
      url: location.pathname + location.search,
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(completed.statusCode).toBe(302);
    const handoff = new URL(String(completed.headers.location));
    expect(handoff.pathname).toBe('/sign-in/complete');
    expect(handoff.searchParams.get('code')).toBeTruthy();
    expect(
      completed.cookies.some((cookie) => cookie.name.includes('refresh') && cookie.httpOnly),
    ).toBe(true);
  });
  it('caps ACS bodies and input, and rate-limits protocol starts', async () => {
    const http = app.getHttpAdapter().getInstance();
    const oversized = await http.inject({
      method: 'POST',
      url: `/api/auth/sso/${CONNECTION}/saml/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `SAMLResponse=${'A'.repeat(256 * 1024)}`,
    });
    expect(oversized.statusCode).toBe(413);
    for (let i = 0; i < 20; i++) await start();
    await expect(start()).rejects.toThrow('sso-rate-limited');
  });
});
