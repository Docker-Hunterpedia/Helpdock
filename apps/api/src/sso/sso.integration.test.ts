import 'reflect-metadata';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createKeyring,
  createSettings,
  decryptSecret,
  encryptSecret,
  LocalInvalidation,
} from '@helpdock/config';
import {
  auditLog,
  brands,
  createDb,
  type DbHandle,
  departments,
  INSTALL_SCOPE_BRAND_ID,
  PostgresSettingsStore,
  settings,
  ssoConnections,
  userBrandRoles,
  userSsoIdentities,
  users,
  uuidv7,
  webauthnCredentials,
  withSystem,
} from '@helpdock/db';
import type { Principal } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { createLogger } from '../logging/logger.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { SsoRequestStore } from './request-store.js';
import { SsoService } from './sso.service.js';

const MASTER_KEY = Buffer.alloc(32, 81).toString('base64');
const ADMIN = uuidv7();
const BRAND = uuidv7();
const OTHER_BRAND = uuidv7();
const principal: Principal = { type: 'staff', id: ADMIN, installAdmin: true, brands: {} };
const connection = (name = 'Work') => ({
  name,
  enabled: true,
  // Enabled connections may not share a domain, so each name gets its own.
  emailDomains: [`${name.toLowerCase().replaceAll(' ', '-')}.example.com`],
  config: { protocol: 'oidc', issuer: 'http://127.0.0.1:3098', clientId: 'work' },
  clientSecret: 'private-client-secret',
});

describe.skipIf(!hasDocker)('M11-01 install SSO configuration', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;

  beforeAll(async () => {
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';
    [postgres, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
    const env = metaEnv({
      masterKey: MASTER_KEY,
      postgres,
      redis: redisContainer,
      graph: { facebookRoot: 'http://127.0.0.1:3097', instagramRoot: 'http://127.0.0.1:3097' },
    });
    const logger = createLogger({
      env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', APP_ROLE: 'api' },
      level: 'silent',
    });
    runtime = await createRuntime({ env, logger });
    owner = createDb({ url: postgres.getConnectionUri() });
    await runtime.db.insert(users).values({
      id: ADMIN,
      email: 'admin@example.com',
      name: 'Admin',
      installAdmin: true,
      status: 'active',
      totpEnabled: true,
      passwordHash: 'fixture-hash',
      totpSecretEncrypted: encryptSecret(
        'JBSWY3DPEHPK3PXP',
        createKeyring({ APP_MASTER_KEY: MASTER_KEY }),
      ),
    });
    await runtime.db.insert(brands).values([
      { id: BRAND, name: 'Brand', prefix: 'BRAND' },
      { id: OTHER_BRAND, name: 'Other', prefix: 'OTHER' },
    ]);
    app = await createApiApp({ runtime });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 300000);

  beforeEach(async () => {
    await owner.db.transaction(async (tx) => {
      await tx.delete(userBrandRoles);
      await tx.delete(userSsoIdentities);
      await tx.delete(ssoConnections);
      await tx.delete(settings).where(sql`${settings.key} LIKE 'sso.%'`);
    });
  });

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await redisContainer?.stop();
    await postgres?.stop();
  });

  const request = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
    identity: Principal | null = principal,
  ) =>
    app.inject({
      method,
      url: `/api/install/sso/${path}`,
      headers: identity === null ? {} : { [DEV_PRINCIPAL_HEADER]: JSON.stringify(identity) },
      ...(payload === undefined ? {} : { payload }),
    });

  it('inspects public certificate details and refuses malformed PEM without exposing parser errors', async () => {
    const pem = (await app.get(SsoService).spKeys()).certificate;
    const inspected = await request('POST', 'certificates/inspect', { certificates: [pem] });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().certificates).toMatchObject([
      {
        subject: expect.any(String),
        fingerprint: expect.stringMatching(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/),
        expiresAt: expect.any(String),
      },
    ]);
    expect(inspected.body).not.toContain('BEGIN CERTIFICATE');
    const invalid = await request('POST', 'certificates/inspect', {
      certificates: ['invalid-pem'],
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('OpenSSL');
    expect(
      (
        await request(
          'POST',
          'certificates/inspect',
          { certificates: [pem] },
          { ...principal, installAdmin: false },
        )
      ).statusCode,
    ).toBe(403);
  });

  it('rolls back the entire settings save when any mapping is invalid', async () => {
    const mappings = [
      { idpGroup: 'Support', brandId: uuidv7(), role: 'viewer', departmentIds: null, position: 0 },
    ];
    const created = await request('POST', 'configurations', { connection: connection(), mappings });
    expect(created.statusCode).toBe(400);
    expect(await owner.db.select().from(ssoConnections)).toEqual([]);
    const valid = await request('POST', 'configurations', {
      connection: connection(),
      mappings: [],
    });
    expect(valid.statusCode).toBe(201);
    const id = valid.json().id as string;
    const updated = await request('PUT', `connections/${id}/configuration`, {
      connection: connection('Changed'),
      mappings,
    });
    expect(updated.statusCode).toBe(400);
    expect((await request('GET', `connections/${id}`)).json().name).toBe('Work');
  });

  it('creates, reads, updates and deletes connections without exposing their secrets', async () => {
    const created = await request('POST', 'connections', connection());
    expect(created.statusCode).toBe(201);
    const id: string = created.json().id;
    expect(created.json()).toMatchObject({
      name: 'Work',
      protocol: 'oidc',
      secretConfigured: true,
    });
    const [stored] = await owner.db.select().from(ssoConnections).where(eq(ssoConnections.id, id));
    expect(stored?.secretEncrypted).not.toContain('private-client-secret');
    expect(
      decryptSecret(stored?.secretEncrypted ?? '', createKeyring({ APP_MASTER_KEY: MASTER_KEY })),
    ).toBe('private-client-secret');
    const detail = await request('GET', `connections/${id}`);
    expect(detail.json().sp.acsUrl).toContain(`/api/auth/sso/${id}/saml/acs`);
    const { clientSecret: _, ...update } = connection('Renamed');
    expect((await request('PUT', `connections/${id}`, update)).statusCode).toBe(200);
    const list = await request('GET', 'connections');
    expect(
      list.json().connections.some((entry: { name: string }) => entry.name === 'Renamed'),
    ).toBe(true);
    for (const response of [created, detail, list])
      expect(response.body).not.toContain('private-client-secret');
    expect((await request('DELETE', `connections/${id}`)).statusCode).toBe(204);
    expect((await request('GET', `connections/${id}`)).statusCode).toBe(404);
    const audits = await owner.db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(audits.map((entry) => entry.action)).toContain('sso.connection.deleted');
    expect(JSON.stringify(audits)).not.toContain('private-client-secret');
  });

  it('denies unauthenticated and brand-admin access and validates route input', async () => {
    expect((await request('GET', 'connections', undefined, null)).statusCode).toBe(401);
    expect(
      (await request('GET', 'connections', undefined, { ...principal, installAdmin: false }))
        .statusCode,
    ).toBe(403);
    expect((await request('GET', 'connections/not-a-uuid')).statusCode).toBe(400);
    expect(
      (await request('POST', 'connections', { ...connection(), config: { protocol: 'oidc' } }))
        .statusCode,
    ).toBe(400);
  });

  it('rejects invalid mapping targets and persists valid mappings atomically', async () => {
    const created = await request('POST', 'connections', connection('Mapping'));
    const id: string = created.json().id;
    const [department] = await withSystem(runtime.db, BRAND, (tx) =>
      tx.insert(departments).values({ brandId: BRAND, name: 'Support' }).returning(),
    );
    const mapping = {
      idpGroup: 'support',
      brandId: BRAND,
      role: 'agent',
      departmentIds: [department?.id],
      position: 0,
    };
    expect(
      (await request('PUT', `connections/${id}/mappings`, { mappings: [mapping] })).statusCode,
    ).toBe(200);
    expect(
      (
        await request('PUT', `connections/${id}/mappings`, {
          mappings: [{ ...mapping, brandId: OTHER_BRAND }],
        })
      ).statusCode,
    ).toBe(400);
    expect((await request('GET', `connections/${id}/mappings`)).json().mappings).toEqual([mapping]);
    expect(
      (
        await request('PUT', `connections/${id}/mappings`, {
          mappings: [mapping, { ...mapping, position: 1 }],
        })
      ).statusCode,
    ).toBe(400);
    await request('DELETE', `connections/${id}`);
  });

  it('prevents both disabling and deleting the last enforced connection', async () => {
    const created = await request('POST', 'connections', connection('Enforced'));
    const id: string = created.json().id;
    expect(
      (await request('PUT', 'settings', { enforced: true, breakGlassUserIds: [uuidv7()] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await request('PUT', 'settings', { enforced: true, breakGlassUserIds: [ADMIN] })).statusCode,
    ).toBe(200);
    expect(
      (await request('PUT', `connections/${id}`, { ...connection('Enforced'), enabled: false }))
        .statusCode,
    ).toBe(409);
    expect((await request('DELETE', `connections/${id}`)).statusCode).toBe(409);
    expect((await request('GET', 'settings')).json().enforced).toBe(true);
    await request('PUT', 'settings', { enforced: false, breakGlassUserIds: [ADMIN] });
    await request('DELETE', `connections/${id}`);
  });

  it('accepts a break-glass admin with a password and an authenticator app or a passkey (ADR 0053)', async () => {
    const make = async (
      label: string,
      overrides: Partial<typeof users.$inferInsert>,
      passkeys = 0,
      verified = true,
    ) => {
      const id = uuidv7();
      await runtime.db.insert(users).values({
        id,
        email: `${label}-${id}@example.com`,
        name: label,
        installAdmin: true,
        status: 'active',
        passwordHash: 'fixture-hash',
        ...overrides,
      });
      for (let index = 0; index < passkeys; index += 1) {
        await runtime.db.insert(webauthnCredentials).values({
          userId: id,
          credentialId: Buffer.from(uuidv7() + String(index)),
          publicKey: Buffer.from('public-key'),
          algorithm: -7,
          backupEligible: false,
          backedUp: false,
          userVerified: verified,
          name: 'Key',
        });
      }
      return id;
    };
    const passkeyOnly = await make('passkey-only', {}, 1);
    const pinless = await make('pinless', {}, 1, false);
    const neither = await make('neither', {});
    const noPassword = await make('no-password', { passwordHash: null }, 1);
    const ordinary = await make('ordinary', { installAdmin: false }, 1);
    const deactivated = await make('deactivated', { status: 'deactivated' }, 1);
    await request('POST', 'connections', connection('Policy'));
    const save = (ids: string[]) =>
      request('PUT', 'settings', { enforced: true, breakGlassUserIds: ids });

    try {
      expect((await save([passkeyOnly])).statusCode).toBe(200);
      expect((await save([passkeyOnly, ADMIN])).statusCode).toBe(200);
      for (const refused of [pinless, neither, noPassword, ordinary, deactivated]) {
        expect((await save([refused])).statusCode).toBe(400);
      }
      const { admins } = (await request('GET', 'targets')).json() as {
        admins: { id: string; eligible: boolean; passkeyNeedsVerification: boolean }[];
      };
      const eligible = (id: string) => admins.find((admin) => admin.id === id)?.eligible;
      expect(eligible(passkeyOnly)).toBe(true);
      expect(eligible(ADMIN)).toBe(true);
      expect(eligible(neither)).toBe(false);
      expect(eligible(pinless)).toBe(false);
      const needsPin = (id: string) =>
        admins.find((admin) => admin.id === id)?.passkeyNeedsVerification;
      expect(needsPin(pinless)).toBe(true);
      expect(needsPin(neither)).toBe(false);
      expect(needsPin(passkeyOnly)).toBe(false);
      expect(eligible(noPassword)).toBe(false);
    } finally {
      await owner.db.delete(users).where(
        sql`${users.id} IN (${sql.join(
          [passkeyOnly, pinless, neither, noPassword, ordinary, deactivated].map(
            (id) => sql`${id}`,
          ),
          sql`, `,
        )})`,
      );
    }
  });

  it('generates one matching persisted SP keypair across concurrent replicas', async () => {
    const service = app.get(SsoService);
    const [first, second] = await Promise.all([service.spKeys(), service.spKeys()]);
    expect(first).toEqual(second);
    expect(new X509Certificate(first.certificate).subject).toContain('Helpdock');
    const [stored] = await owner.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'sso.spPrivateKey'));
    expect(stored?.value).toMatch(/^v1\./);
    expect(stored?.value).not.toContain('PRIVATE KEY');
    expect(await service.spKeys()).toEqual(first);
  });

  it('consumes request state exactly once across replicas and isolates protocol namespaces', async () => {
    const schema = z.object({ nonce: z.string() });
    const first = new SsoRequestStore(runtime.redis, 'oidc', schema);
    const second = new SsoRequestStore(runtime.redis, 'oidc', schema);
    const saml = new SsoRequestStore(runtime.redis, 'saml', schema);
    const id = 'single-use-request-identifier';
    await first.put(id, { nonce: 'oidc' });
    await saml.put(id, { nonce: 'saml' });
    const consumed = await Promise.all([first.consume(id), second.consume(id)]);
    expect(consumed.filter((entry) => entry !== null)).toEqual([{ nonce: 'oidc' }]);
    expect(await saml.consume(id)).toEqual({ nonce: 'saml' });
    await expect(first.put('too-short', { nonce: 'invalid' })).rejects.toThrow();
  });

  it('backfills manual membership provenance without widening tenant access', async () => {
    await withSystem(runtime.db, BRAND, (tx) =>
      tx.insert(userBrandRoles).values({ userId: ADMIN, brandId: BRAND, role: 'admin' }),
    );
    const owned = await withSystem(runtime.db, BRAND, (tx) => tx.select().from(userBrandRoles));
    expect(owned[0]).toMatchObject({ source: 'manual', ssoConnectionId: null });
    expect(
      await withSystem(runtime.db, OTHER_BRAND, (tx) => tx.select().from(userBrandRoles)),
    ).toEqual([]);
  });
  it('serializes competing changes so enforcement retains an enabled connection', async () => {
    const a = (await request('POST', 'connections', connection('Race A'))).json();
    const b = (await request('POST', 'connections', connection('Race B'))).json();
    await request('PUT', 'settings', { enforced: true, breakGlassUserIds: [ADMIN] });
    const outcomes = await Promise.all([
      request('PUT', `connections/${a.id}`, { ...connection('Race A'), enabled: false }),
      request('PUT', `connections/${b.id}`, { ...connection('Race B'), enabled: false }),
    ]);
    expect(outcomes.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await request('PUT', 'settings', { enforced: false, breakGlassUserIds: [ADMIN] });
    await request('DELETE', `connections/${a.id}`);
    await request('DELETE', `connections/${b.id}`);
  });

  it('permits claim changes but refuses changing a linked identity authority', async () => {
    const id: string = (await request('POST', 'connections', connection('Linked'))).json().id;
    await runtime.db.insert(userSsoIdentities).values({
      userId: ADMIN,
      connectionId: id,
      subject: 'stable-subject',
      emailAtLink: 'admin@example.com',
    });
    expect(
      (
        await request('PUT', `connections/${id}`, {
          ...connection('Linked'),
          config: { ...connection().config, nameClaim: 'display_name' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request('PUT', `connections/${id}`, {
          ...connection('Linked'),
          config: { ...connection().config, clientId: 'different-client' },
        })
      ).statusCode,
    ).toBe(409);
    expect((await request('DELETE', `connections/${id}`)).statusCode).toBe(409);
    await runtime.db.delete(userSsoIdentities).where(eq(userSsoIdentities.connectionId, id));
    await request('DELETE', `connections/${id}`);
  });

  it('refuses an email domain another enabled connection already lists, on create, update and enable (#219)', async () => {
    const domainTaken = {
      error: { sso: { reason: 'sso-email-domain-taken', domains: ['work.example.com'] } },
    };
    const work = (await request('POST', 'connections', connection())).json();
    const overlapping = { ...connection('Staging'), emailDomains: ['WORK.example.com'] };
    const created = await request('POST', 'connections', overlapping);
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject(domainTaken);
    expect(
      (await request('POST', 'configurations', { connection: overlapping, mappings: [] })).json(),
    ).toMatchObject(domainTaken);
    const staging = (await request('POST', 'connections', connection('Staging'))).json();
    expect((await request('PUT', `connections/${staging.id}`, overlapping)).json()).toMatchObject(
      domainTaken,
    );
    const disabled = await request('POST', 'connections', {
      ...overlapping,
      name: 'Disabled',
      enabled: false,
    });
    expect(disabled.statusCode).toBe(201);
    const enabled = await request('PUT', `connections/${disabled.json().id}`, {
      ...overlapping,
      name: 'Disabled',
    });
    expect(enabled.statusCode).toBe(409);
    expect(enabled.json()).toMatchObject(domainTaken);
    expect((await request('PUT', `connections/${work.id}`, connection())).statusCode).toBe(200);
    expect(
      (await request('PUT', `connections/${work.id}`, { ...connection(), enabled: false }))
        .statusCode,
    ).toBe(200);
    expect((await request('PUT', `connections/${staging.id}`, overlapping)).statusCode).toBe(200);
  });

  it('validates SAML certificates before saving configuration', async () => {
    const keys = await app.get(SsoService).spKeys();
    const saml = {
      name: 'SAML Work',
      config: {
        protocol: 'saml',
        idpEntityId: 'urn:work',
        idpSsoUrl: 'http://127.0.0.1:3099',
        idpCertificates: [keys.certificate],
      },
    };
    const created = await request('POST', 'connections', saml);
    expect(created.statusCode).toBe(201);
    expect(
      (
        await request('POST', 'connections', {
          ...saml,
          name: 'Invalid SAML',
          config: { ...saml.config, idpCertificates: ['invalid'] },
        })
      ).statusCode,
    ).toBe(400);
    await request('DELETE', `connections/${created.json().id}`);
  });

  it('expires request state without allowing another protocol to spend it', async () => {
    const store = new SsoRequestStore(runtime.redis, 'oidc', z.object({ nonce: z.string() }));
    const id = 'expiring-request-identifier';
    await store.put(id, { nonce: 'expired' });
    const key = `auth:sso:req:oidc:${createHash('sha256').update(id).digest('hex')}`;
    expect(await runtime.redis.ttl(key)).toBeGreaterThan(0);
    await runtime.redis.pexpire(key, 0);
    expect(await store.consume(id)).toBeNull();
  });

  it('round-trips the SSO migration over populated manual memberships', async () => {
    await withSystem(runtime.db, BRAND, (tx) =>
      tx.insert(userBrandRoles).values({ userId: ADMIN, brandId: BRAND, role: 'admin' }),
    );
    const migration = await readFile(
      new URL('../../../../packages/db/drizzle/0053_sso.sql', import.meta.url),
      'utf8',
    );
    const rollback = new Error('rollback migration round-trip');
    await expect(
      owner.db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`ALTER TABLE user_brand_roles DROP COLUMN sso_connection_id;
        ALTER TABLE user_brand_roles DROP COLUMN source;
        DROP TABLE user_sso_identities; DROP TABLE sso_role_mappings; DROP TABLE sso_connections;
        DROP TYPE brand_role_source; DROP TYPE sso_protocol;`),
        );
        for (const statement of migration.split('--> statement-breakpoint'))
          await tx.execute(sql.raw(statement));
        const [membership] = await tx
          .select()
          .from(userBrandRoles)
          .where(eq(userBrandRoles.userId, ADMIN));
        expect(membership).toMatchObject({ source: 'manual', ssoConnectionId: null });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      (await withSystem(runtime.db, BRAND, (tx) => tx.select().from(userBrandRoles)))[0]?.source,
    ).toBe('manual');
  });
  it('honors environment locks without allowing partial settings changes', async () => {
    const resolver = createSettings({
      env: { HD_SSO_ENFORCED: 'false' },
      store: new PostgresSettingsStore({ db: runtime.db }),
      keyring: createKeyring(runtime.env),
      invalidation: new LocalInvalidation(),
    });
    const service = new SsoService({
      db: runtime.db,
      redis: runtime.redis,
      settings: resolver,
      keyring: createKeyring(runtime.env),
      env: runtime.env,
    });
    const call = <T>(fn: () => Promise<T>) =>
      withSystem(runtime.db, INSTALL_SCOPE_BRAND_ID, (tx) => {
        const context = new RequestContext({
          requestId: 'locked-setting',
          method: 'PUT',
          path: '/',
        });
        context.principal = principal;
        context.tx = tx;
        return runInRequestContext(context, fn);
      });
    try {
      expect(await call(() => service.settings())).toMatchObject({
        enforced: false,
        enforcedLocked: true,
      });
      await expect(
        call(() => service.saveSettings({ enforced: true, breakGlassUserIds: [ADMIN] })),
      ).rejects.toThrow('sso-settings-locked');
      expect(await call(() => service.settings())).toMatchObject({
        enforced: false,
        breakGlassUserIds: [],
      });
      expect(
        await call(() => service.saveSettings({ enforced: false, breakGlassUserIds: [ADMIN] })),
      ).toMatchObject({ enforced: false, breakGlassUserIds: [ADMIN], enforcedLocked: true });
    } finally {
      await resolver.close();
    }
  });
});
