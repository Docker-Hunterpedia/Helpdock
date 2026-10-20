import { createKeyring, encryptSecret } from '@helpdock/config';
import { uuidv7 as newSessionId } from '@helpdock/db';
import { generate } from 'otplib';
import { AuthService } from '../auth/auth.service.js';
import { EmailTokenStore } from '../auth/email-token.store.js';
import { familyKey, PRINCIPAL_REVOKED_CHANNEL } from '../auth/redis-keys.js';
import { lockSessionWriteAuthority } from '../auth/session/authority-lock.js';
import { RefreshStore } from '../auth/session/refresh-store.js';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { INVITE_TTL_SECONDS, InviteStore } from '../staff/invite.store.js';
import { StaffRepository as BrandStaffRepository } from '../staff/staff.repository.js';
import { StaffService } from '../staff/staff.service.js';
import { SsoSignInPolicy } from './sign-in-policy.js';
import { SsoTestSignInService } from './test-sign-in.service.js';
import 'reflect-metadata';
import {
  auditLog,
  brands,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  settings,
  ssoConnections,
  ssoRoleMappings,
  userBrandRoles,
  userSsoIdentities,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from '../auth/session/session.service.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { silentLogger } from '../testing/silent-logger.js';
import { SsoIdentityService } from './identity.service.js';
import type { SsoAssertion } from './oidc-contracts.js';

const ADMIN = uuidv7();
const BRAND = uuidv7();
const MANUAL_BRAND = uuidv7();
const CONNECTION = uuidv7();
const OTHER_CONNECTION = uuidv7();
const KEY = Buffer.alloc(32, 88).toString('base64');
const assertion = (overrides: Partial<SsoAssertion> = {}): SsoAssertion => ({
  connectionId: CONNECTION,
  subject: 'staff-1',
  email: 'ada@example.com',
  emailVerified: true,
  name: 'Ada',
  groups: ['Support'],
  ...overrides,
});

describe.skipIf(!hasDocker)(
  'M11-04 identity provisioning and sync on real Postgres and Redis',
  () => {
    let postgres: StartedPostgreSqlContainer;
    let redisContainer: StartedRedisContainer;
    let runtime: Runtime;
    let owner: DbHandle;
    let app: ApiApp;
    let service: SsoIdentityService;
    let sessions: SessionService;

    beforeAll(async () => {
      [postgres, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
      runtime = await createRuntime({
        env: {
          ...metaEnv({
            masterKey: KEY,
            postgres,
            redis: redisContainer,
            graph: {
              facebookRoot: 'http://127.0.0.1:8080',
              instagramRoot: 'http://127.0.0.1:8080',
            },
          }),
          AUTH_SESSION_MAX_HOURS: 720,
        },
        logger: silentLogger(),
      });
      owner = createDb({ url: postgres.getConnectionUri() });
      await runtime.db.insert(users).values({
        id: ADMIN,
        email: 'admin@example.com',
        name: 'Admin',
        status: 'active',
        installAdmin: true,
      });
      await runtime.db.insert(brands).values([
        { id: BRAND, name: 'SSO', prefix: 'SSO' },
        { id: MANUAL_BRAND, name: 'Manual', prefix: 'MAN' },
      ]);
      app = await createApiApp({ runtime });
      await app.init();
      sessions = app.get(SessionService);
      service = new SsoIdentityService({
        db: runtime.db,
        sessions,
        redis: runtime.redis,
        settings: runtime.settings,
      });
    }, 300000);

    beforeEach(async () => {
      await runtime.redis.flushdb();
      await owner.db.delete(userBrandRoles);
      await owner.db.delete(userSsoIdentities);
      await owner.db.delete(ssoConnections);
      await owner.db.delete(users).where(eq(users.email, 'ada@example.com'));
      await owner.db.delete(auditLog);
      await owner.db.delete(settings);
      await owner.db.update(brands).set({ status: 'active' }).where(eq(brands.id, BRAND));
      await owner.db.insert(ssoConnections).values([
        {
          id: CONNECTION,
          name: 'Work',
          protocol: 'oidc',
          enabled: true,
          emailDomains: ['example.com'],
          defaultAccess: { brandId: BRAND, role: 'viewer', departmentIds: null },
          createdBy: ADMIN,
          config: ssoConnectionConfigSchema.parse({
            protocol: 'oidc',
            issuer: 'https://idp.example.com',
            clientId: 'helpdock',
          }),
        },
        {
          id: OTHER_CONNECTION,
          name: 'Other',
          protocol: 'oidc',
          enabled: true,
          createdBy: ADMIN,
          config: {},
        },
      ]);
    });

    afterAll(async () => {
      await app?.close();
      await runtime?.close();
      await owner?.close();
      await redisContainer?.stop();
      await postgres?.stop();
    });

    it('creates one passwordless account under simultaneous first sign-ins and records provenance', async () => {
      const attempts = await Promise.all([
        service.signIn(assertion()),
        service.signIn(assertion()),
      ]);
      expect(attempts[0]?.user.id).toBe(attempts[1]?.user.id);
      const accounts = await owner.db
        .select()
        .from(users)
        .where(eq(users.email, 'ada@example.com'));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        status: 'active',
        passwordHash: null,
        installAdmin: false,
      });
      expect(await owner.db.select().from(userBrandRoles)).toMatchObject([
        { source: 'sso', ssoConnectionId: CONNECTION, brandId: BRAND },
      ]);
      const actions = (await owner.db.select().from(auditLog)).map((row) => row.action);
      expect(actions.filter((action) => action === 'sso.user.provisioned')).toHaveLength(1);
      expect(actions.filter((action) => action === 'sso.roles.synced')).toHaveLength(1);
    });

    it('links an invited account case-insensitively and preserves its manual role', async () => {
      const [invited] = await owner.db
        .insert(users)
        .values({ email: 'ada@example.com', name: 'Invited', status: 'invited' })
        .returning();
      if (!invited) throw new Error('Missing invite fixture');
      await owner.db
        .insert(userBrandRoles)
        .values({ userId: invited.id, brandId: BRAND, role: 'admin' });
      const completed = await service.signIn(assertion({ email: 'ADA@EXAMPLE.COM' }));
      expect(completed.user.id).toBe(invited.id);
      expect(completed.user.name).toBe('Ada');
      expect(await owner.db.select().from(userBrandRoles)).toMatchObject([
        { source: 'manual', role: 'admin', ssoConnectionId: null },
      ]);
      expect(
        (await owner.db.select().from(auditLog)).some((row) => row.action === 'sso.user.linked'),
      ).toBe(true);
    });

    it('uses the stable subject after linking even when the asserted email changes', async () => {
      const first = await service.signIn(assertion());
      expect((await service.signIn(assertion({ email: 'new@another.example' }))).user.id).toBe(
        first.user.id,
      );
      expect(await owner.db.select().from(users).where(eq(users.id, first.user.id))).toMatchObject([
        { email: 'ada@example.com' },
      ]);
    });

    it('refuses a second subject on the same connection taking over a linked account by email (#219)', async () => {
      const { user } = await service.signIn(assertion());
      const takeover = assertion({ subject: 'recycled-address' });
      await expect(service.signIn(takeover)).rejects.toMatchObject({
        auth: { code: 'sso-identity-conflict' },
      });
      await expect(service.preview(takeover)).rejects.toMatchObject({
        auth: { code: 'sso-identity-conflict' },
      });
      expect(await owner.db.select().from(userSsoIdentities)).toMatchObject([
        { userId: user.id, subject: 'staff-1' },
      ]);
      expect(
        (await owner.db.select().from(auditLog)).filter((row) => row.action === 'sso.user.linked'),
      ).toEqual([]);
    });

    it('refuses email linking to an account already linked through another connection (#219)', async () => {
      await owner.db
        .update(ssoConnections)
        .set({ emailDomains: ['example.com'] })
        .where(eq(ssoConnections.id, OTHER_CONNECTION));
      const [user] = await owner.db
        .insert(users)
        .values({ email: 'ada@example.com', name: 'Ada', status: 'active' })
        .returning();
      if (!user) throw new Error('Missing user fixture');
      await owner.db
        .insert(userBrandRoles)
        .values({ userId: user.id, brandId: BRAND, role: 'admin' });
      await owner.db.insert(userSsoIdentities).values({
        userId: user.id,
        connectionId: OTHER_CONNECTION,
        subject: 'break-glass-admin',
        emailAtLink: 'ada@example.com',
      });
      await expect(service.signIn(assertion())).rejects.toMatchObject({
        auth: { code: 'sso-identity-conflict' },
      });
      expect(await owner.db.select().from(userSsoIdentities)).toMatchObject([
        { connectionId: OTHER_CONNECTION, subject: 'break-glass-admin' },
      ]);
      expect(await owner.db.select().from(userBrandRoles)).toMatchObject([
        { source: 'manual', role: 'admin' },
      ]);
    });

    it('allows only one identity per account on each connection', async () => {
      const { user } = await service.signIn(assertion());
      await expect(
        owner.db.insert(userSsoIdentities).values({
          userId: user.id,
          connectionId: CONNECTION,
          subject: 'second-subject',
          emailAtLink: 'ada@example.com',
        }),
      ).rejects.toMatchObject({ cause: { constraint_name: 'sso_identity_user_connection_key' } });
    });

    it('refuses email linking and JIT for an unverified address but keeps the subject link', async () => {
      await expect(service.signIn(assertion({ emailVerified: false }))).rejects.toMatchObject({
        auth: { code: 'sso-email-unverified' },
      });
      expect(await owner.db.select().from(users).where(eq(users.email, 'ada@example.com'))).toEqual(
        [],
      );
      const linked = await service.signIn(assertion());
      expect((await service.signIn(assertion({ emailVerified: false }))).user.id).toBe(
        linked.user.id,
      );
    });

    it.each([
      [{ emailDomains: ['elsewhere.example'] as string[] }, 'sso-email-unverified'],
      [{ jitEnabled: false }, 'no-account'],
      [{ defaultAccess: null }, 'sso-no-access'],
      [{ enabled: false }, 'sso-connection-disabled'],
    ] as const)(
      'refuses unauthorized provisioning without leaving an account (%s)',
      async (configuration, code) => {
        await owner.db
          .update(ssoConnections)
          .set(configuration)
          .where(eq(ssoConnections.id, CONNECTION));
        await expect(service.signIn(assertion())).rejects.toMatchObject({ auth: { code } });
        expect(
          await owner.db.select().from(users).where(eq(users.email, 'ada@example.com')),
        ).toEqual([]);
        expect(await owner.db.select().from(userSsoIdentities)).toEqual([]);
      },
    );

    it('commits removal of the final role and revokes its session before denying sign-in', async () => {
      const { user } = await service.signIn(assertion());
      const session = await sessions.open({ userId: user.id, userAgent: 'integration' });
      expect(session).not.toBeNull();
      await owner.db
        .update(ssoConnections)
        .set({ defaultAccess: null })
        .where(eq(ssoConnections.id, CONNECTION));
      await expect(service.signIn(assertion({ groups: [] }))).rejects.toMatchObject({
        auth: { code: 'sso-no-access' },
      });
      expect(await owner.db.select().from(userBrandRoles)).toEqual([]);
      expect(await sessions.listSessions(user.id)).toEqual([]);
      expect((await owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.status).toBe(
        'active',
      );
    });

    it('changes mapped roles, revokes sessions, and preserves manual access in another brand', async () => {
      const { user } = await service.signIn(assertion());
      await owner.db
        .insert(userBrandRoles)
        .values({ userId: user.id, brandId: MANUAL_BRAND, role: 'admin' });
      await sessions.open({ userId: user.id, userAgent: 'integration' });
      await owner.db.insert(ssoRoleMappings).values({
        connectionId: CONNECTION,
        idpGroup: 'Support',
        brandId: BRAND,
        role: 'team_leader',
        departmentIds: null,
        position: 0,
      });
      await service.signIn(assertion());
      const roles = await owner.db.select().from(userBrandRoles);
      expect(roles.find((row) => row.brandId === BRAND)).toMatchObject({
        source: 'sso',
        role: 'team_leader',
      });
      expect(roles.find((row) => row.brandId === MANUAL_BRAND)).toMatchObject({
        source: 'manual',
        role: 'admin',
      });
      expect(await sessions.listSessions(user.id)).toEqual([]);
    });

    it('does not grant access through a deleting brand or stale department mapping', async () => {
      await owner.db.update(brands).set({ status: 'deleting' }).where(eq(brands.id, BRAND));
      await expect(service.signIn(assertion())).rejects.toMatchObject({
        auth: { code: 'sso-no-access' },
      });
      await owner.db.update(brands).set({ status: 'active' }).where(eq(brands.id, BRAND));
      await owner.db
        .update(ssoConnections)
        .set({ defaultAccess: { brandId: BRAND, role: 'agent', departmentIds: [uuidv7()] } })
        .where(eq(ssoConnections.id, CONNECTION));
      await expect(service.signIn(assertion())).rejects.toMatchObject({
        auth: { code: 'sso-no-access' },
      });
      expect(await owner.db.select().from(userBrandRoles)).toEqual([]);
    });

    it('refuses another connection taking ownership of an existing SSO membership', async () => {
      const [user] = await owner.db
        .insert(users)
        .values({ email: 'ada@example.com', name: 'Ada', status: 'active' })
        .returning();
      if (!user) throw new Error('Missing user fixture');
      await owner.db.insert(userBrandRoles).values({
        userId: user.id,
        brandId: BRAND,
        role: 'viewer',
        source: 'sso',
        ssoConnectionId: OTHER_CONNECTION,
      });
      await expect(service.signIn(assertion())).rejects.toMatchObject({
        auth: { code: 'sso-no-access' },
      });
      expect(await owner.db.select().from(userBrandRoles)).toMatchObject([
        { ssoConnectionId: OTHER_CONNECTION },
      ]);
      expect(await owner.db.select().from(userSsoIdentities)).toEqual([]);
    });

    it('previews JIT and effective roles without writing accounts, identities, roles, audit or sessions', async () => {
      expect(await service.preview(assertion())).toMatchObject({
        user: null,
        wouldCreate: true,
        access: [{ brandId: BRAND, role: 'viewer' }],
        conflict: false,
      });
      expect(await owner.db.select().from(users).where(eq(users.email, 'ada@example.com'))).toEqual(
        [],
      );
      for (const table of [userSsoIdentities, userBrandRoles, auditLog])
        expect(await owner.db.select().from(table)).toEqual([]);
      expect(await runtime.redis.dbsize()).toBe(0);
    });
    it('SSO accepts an invited verified-email account and keeps its manual invitation grant', async () => {
      const [invited] = await owner.db
        .insert(users)
        .values({ email: 'ada@example.com', name: 'Invited', status: 'invited' })
        .returning();
      if (!invited) throw new Error('Missing invite');
      await owner.db
        .insert(userBrandRoles)
        .values({ userId: invited.id, brandId: BRAND, role: 'viewer' });
      const tokens = new EmailTokenStore(runtime.redis);
      const invites = new InviteStore(runtime.redis);
      const issuedAt = Date.now();
      const token = await tokens.issue(
        {
          purpose: 'invite',
          userId: invited.id,
          brandId: BRAND,
          email: invited.email,
          role: 'viewer',
          departmentIds: 'all',
          issuedAt,
        },
        INVITE_TTL_SECONDS,
      );
      await invites.remember(
        BRAND,
        invited.id,
        {
          tokenHash: tokens.hashOf(token),
          issuedAt,
          expiresAt: issuedAt + INVITE_TTL_SECONDS * 1000,
        },
        INVITE_TTL_SECONDS,
      );
      expect(await tokens.read(token, 'invite')).not.toBeNull();
      const outcome = await app.get(AuthService).completeSso(assertion(), undefined);
      expect(outcome.kind).toBe('session');
      expect(await tokens.read(token, 'invite')).toBeNull();
      expect(await invites.read(BRAND, invited.id)).toBeNull();
      expect(
        await owner.db.select().from(auditLog).where(eq(auditLog.action, 'staff.invite.accepted')),
      ).toMatchObject([{ brandId: BRAND, targetId: invited.id }]);
      expect((await owner.db.select().from(users).where(eq(users.id, invited.id)))[0]?.status).toBe(
        'active',
      );
      expect(await owner.db.select().from(userBrandRoles)).toMatchObject([{ source: 'manual' }]);
    });

    it.each([false, true])(
      'uses local TOTP unless the administrator vouches for IdP MFA (%s)',
      async (idpEnforcesMfa) => {
        await owner.db.insert(users).values({
          email: 'ada@example.com',
          name: 'Ada',
          status: 'active',
          totpEnabled: true,
          totpSecretEncrypted: encryptSecret(
            'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            createKeyring({ APP_MASTER_KEY: KEY }),
          ),
        });
        await owner.db
          .update(ssoConnections)
          .set({ idpEnforcesMfa })
          .where(eq(ssoConnections.id, CONNECTION));
        const outcome = await app.get(AuthService).completeSso(assertion(), undefined);
        expect(outcome.kind).toBe(idpEnforcesMfa ? 'session' : 'totp-required');
      },
    );

    it('enforces SSO across password, magic link, OAuth and invite; emergency password still requires fresh TOTP', async () => {
      const auth = app.get(AuthService);
      const password = 'M11-only-correct-horse-passphrase!';
      await owner.db
        .update(users)
        .set({
          passwordHash: await auth.hashPassword(password),
          totpEnabled: true,
          totpSecretEncrypted: encryptSecret(
            'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            createKeyring({ APP_MASTER_KEY: KEY }),
          ),
        })
        .where(eq(users.id, ADMIN));
      await owner.db
        .insert(userBrandRoles)
        .values({ userId: ADMIN, brandId: BRAND, role: 'viewer' });
      await owner.db.insert(settings).values([
        { brandId: INSTALL_SCOPE_BRAND_ID, updatedBy: ADMIN, key: 'sso.enforced', value: 'true' },
        {
          brandId: INSTALL_SCOPE_BRAND_ID,
          updatedBy: ADMIN,
          key: 'sso.breakGlassUserIds',
          value: JSON.stringify([ADMIN]),
        },
      ]);
      const signIn = (email: string) =>
        auth.signIn({
          email,
          password,
          ip: 'policy-test',
          userAgent: undefined,
          trustedDeviceCookie: undefined,
        });
      for (const email of ['ada@example.com', 'unknown@example.com']) {
        await expect(signIn(email)).rejects.toMatchObject({ auth: { code: 'sso-required' } });
        await expect(auth.requestMagicLink({ email, ip: 'magic-policy' })).rejects.toMatchObject({
          auth: { code: 'sso-required' },
        });
      }
      await expect(auth.startOauth('google')).rejects.toMatchObject({
        auth: { code: 'sso-required' },
      });
      await expect(
        auth.assertLocalSignInAllowed('admin@example.com', 'invite'),
      ).rejects.toMatchObject({ auth: { code: 'sso-required' } });
      const tokens = new EmailTokenStore(runtime.redis);
      const token = await tokens.issue(
        { purpose: 'magic-link', userId: ADMIN, email: 'admin@example.com', issuedAt: Date.now() },
        600,
      );
      await expect(auth.previewMagicLink({ token, ip: 'magic-policy' })).rejects.toMatchObject({
        auth: { code: 'sso-required' },
      });
      await expect(
        auth.consumeMagicLink({ token, ip: 'magic-policy', userAgent: undefined }),
      ).rejects.toMatchObject({ auth: { code: 'sso-required' } });
      expect(await tokens.consume(token, 'magic-link')).not.toBeNull();
      const outcome = await signIn('admin@example.com');
      expect(outcome.kind).toBe('totp-required');
      if (outcome.kind !== 'totp-required') throw new Error('Expected emergency TOTP');
      await expect(
        auth.useRecoveryCode({
          ip: '203.0.113.5',
          challengeId: outcome.challengeId,
          code: 'unused',
          userAgent: undefined,
        }),
      ).rejects.toMatchObject({ auth: { code: 'sso-required' } });
      const code = await generate({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
      await expect(
        auth.verifyTotp({
          ip: '203.0.113.5',
          challengeId: outcome.challengeId,
          code,
          userAgent: undefined,
          trustDevice: false,
        }),
      ).resolves.toMatchObject({ issued: { session: { user: { id: ADMIN } } } });
      const methods = await auth.methods();
      expect(methods).toMatchObject({
        ssoEnforced: true,
        magicLink: false,
        oauth: { google: false, microsoft: false, github: false },
        // A passkey alone is a local first factor, refused under enforcement (ADR 0050).
        passkey: false,
      });
    });

    it('rechecks a pending local TOTP challenge after enforcement changes', async () => {
      const auth = app.get(AuthService);
      const password = 'M11-only-correct-horse-passphrase!';
      const [user] = await owner.db
        .insert(users)
        .values({
          email: 'ada@example.com',
          name: 'Ada',
          status: 'active',
          passwordHash: await auth.hashPassword(password),
          totpEnabled: true,
          totpSecretEncrypted: encryptSecret(
            'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            createKeyring({ APP_MASTER_KEY: KEY }),
          ),
        })
        .returning();
      if (!user) throw new Error('Missing pending user');
      await owner.db
        .insert(userBrandRoles)
        .values({ userId: user.id, brandId: BRAND, role: 'viewer' });
      const outcome = await auth.signIn({
        email: user.email,
        password,
        ip: 'pending-test',
        userAgent: undefined,
        trustedDeviceCookie: undefined,
      });
      if (outcome.kind !== 'totp-required') throw new Error('Expected pending TOTP');
      await owner.db.insert(settings).values({
        brandId: INSTALL_SCOPE_BRAND_ID,
        updatedBy: ADMIN,
        key: 'sso.enforced',
        value: 'true',
      });
      const code = await generate({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
      await expect(
        auth.verifyTotp({
          ip: '203.0.113.5',
          challengeId: outcome.challengeId,
          code,
          userAgent: undefined,
          trustDevice: false,
        }),
      ).rejects.toMatchObject({ auth: { code: 'sso-required' } });
      expect(await sessions.listSessions(user.id)).toEqual([]);
    });

    it('refuses JIT when its only mapped role is disabled by install policy', async () => {
      await runtime.settings.set('roles.viewerEnabled', false, { updatedBy: ADMIN });
      try {
        await expect(service.signIn(assertion())).rejects.toMatchObject({
          auth: { code: 'sso-no-access' },
        });
        expect(
          await owner.db.select().from(users).where(eq(users.email, 'ada@example.com')),
        ).toEqual([]);
        expect(await owner.db.select().from(userBrandRoles)).toEqual([]);
      } finally {
        await runtime.settings.set('roles.viewerEnabled', true, { updatedBy: ADMIN });
      }
    });

    it('discovers matching enabled domains without querying account existence', async () => {
      const policy = app.get(SsoSignInPolicy);
      expect(await policy.discover('unknown@EXAMPLE.COM')).toEqual({
        connections: [{ id: CONNECTION, name: 'Work' }],
      });
      expect(await policy.discover('unknown@elsewhere.example')).toEqual({ connections: [] });
      await owner.db
        .update(ssoConnections)
        .set({ enabled: false })
        .where(eq(ssoConnections.id, CONNECTION));
      expect(await policy.discover('ada@example.com')).toEqual({ connections: [] });
    });
    it('revokes a pending SSO TOTP completion when the connection is disabled', async () => {
      await owner.db.insert(users).values({
        email: 'ada@example.com',
        name: 'Ada',
        status: 'active',
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(
          'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          createKeyring({ APP_MASTER_KEY: KEY }),
        ),
      });
      const auth = app.get(AuthService);
      const outcome = await auth.completeSso(assertion(), undefined);
      if (outcome.kind !== 'totp-required') throw new Error('Expected SSO TOTP');
      await owner.db
        .update(ssoConnections)
        .set({ enabled: false })
        .where(eq(ssoConnections.id, CONNECTION));
      await expect(
        auth.verifyTotp({
          ip: '203.0.113.5',
          challengeId: outcome.challengeId,
          code: '000000',
          userAgent: undefined,
          trustDevice: false,
        }),
      ).rejects.toMatchObject({ auth: { code: 'sso-connection-disabled' } });
    });

    it('connection tests write no identity data or session and results belong only to the initiating admin', async () => {
      const tests = app.get(SsoTestSignInService);
      const asAdmin = <T>(id: string, run: () => Promise<T>) =>
        withSystem(runtime.db, INSTALL_SCOPE_BRAND_ID, (tx) => {
          const context = new RequestContext({
            requestId: 'sso-preview',
            method: 'POST',
            path: '/api/install/sso',
          });
          context.tx = tx;
          context.principal = { type: 'staff', id, installAdmin: true, brands: {} };
          return runInRequestContext(context, run);
        });
      const started = await asAdmin(ADMIN, () => tests.start(CONNECTION));
      const returnTo = new URL(started.startUrl).searchParams.get('returnTo') ?? '';
      expect(await tests.complete({ assertion: assertion(), returnTo })).toBe(
        new URL(returnTo, runtime.env.APP_URL).toString(),
      );
      const key = new URL(returnTo, runtime.env.APP_URL).searchParams.get('test') ?? '';
      await expect(asAdmin(uuidv7(), () => tests.result(CONNECTION, key))).rejects.toThrow(
        'another administrator',
      );
      const preview = await asAdmin(ADMIN, () => tests.result(CONNECTION, key));
      expect(preview).toMatchObject({
        wouldCreate: true,
        user: null,
        claims: { subject: 'staff-1' },
        access: [{ role: 'viewer' }],
      });
      await expect(asAdmin(ADMIN, () => tests.result(CONNECTION, key))).rejects.toThrow('expired');
      expect(await owner.db.select().from(users).where(eq(users.email, 'ada@example.com'))).toEqual(
        [],
      );
      for (const table of [userSsoIdentities, userBrandRoles, auditLog])
        expect(await owner.db.select().from(table)).toEqual([]);
      expect(await runtime.redis.dbsize()).toBe(0);
      await expect(tests.complete({ assertion: assertion(), returnTo })).rejects.toThrow('expired');
    });
    it('expires an SSO session after twelve hours even when normal sessions allow thirty days', async () => {
      const outcome = await app.get(AuthService).completeSso(assertion(), undefined);
      if (outcome.kind !== 'session') throw new Error('Expected SSO session');
      const cookie = outcome.issued.refreshCookieValue;
      await runtime.redis.hset(
        familyKey(cookie.fam),
        'issuedAt',
        String(Math.floor(Date.now() / 1000) - 13 * 3600),
      );
      expect(
        await sessions.refresh({ familyId: cookie.fam, token: cookie.token, userAgent: undefined }),
      ).toEqual({ status: 'rejected' });
    });
    it('does not mint an access token beyond the SSO family absolute expiry', async () => {
      const outcome = await app.get(AuthService).completeSso(assertion(), undefined);
      if (outcome.kind !== 'session') throw new Error('Expected SSO session');
      const cookie = outcome.issued.refreshCookieValue;
      await runtime.redis.hset(
        familyKey(cookie.fam),
        'issuedAt',
        String(Math.floor(Date.now() / 1000) - 12 * 3600 + 60),
      );
      const refreshed = await sessions.refresh({
        familyId: cookie.fam,
        token: cookie.token,
        userAgent: undefined,
      });
      if (refreshed.status !== 'rotated') throw new Error('Expected refresh before expiry');
      expect(refreshed.issued.expiresInSeconds).toBeLessThanOrEqual(60);
    });
    it('keeps a role an administrator explicitly changed by hand after SSO provisioning', async () => {
      const { user } = await service.signIn(assertion());
      const [membership] = await owner.db
        .select()
        .from(userBrandRoles)
        .where(eq(userBrandRoles.userId, user.id));
      if (!membership) throw new Error('Missing SSO membership');
      await withSystem(runtime.db, BRAND, (tx) =>
        new BrandStaffRepository().updateMembership(tx, membership.id, {
          role: 'admin',
          departmentIds: null,
        }),
      );
      expect((await owner.db.select().from(userBrandRoles))[0]).toMatchObject({
        source: 'manual',
        ssoConnectionId: null,
      });
      await service.signIn(assertion());
      expect((await owner.db.select().from(userBrandRoles))[0]).toMatchObject({
        role: 'admin',
        source: 'manual',
        ssoConnectionId: null,
      });
    });
    it('locks staff edits before membership writes to avoid deadlocking SSO authority changes', async () => {
      const { user } = await service.signIn(assertion());
      let editing: Promise<unknown> | undefined;
      const holding = withSystem(runtime.db, BRAND, async (tx) => {
        await lockSessionWriteAuthority(tx, user.id);
        editing = withSystem(runtime.db, BRAND, (editTx) =>
          app.get(StaffService).update(
            {
              tx: editTx,
              brandId: BRAND,
              actor: { userId: ADMIN, role: 'admin', departmentIds: 'all', installAdmin: true },
            },
            user.id,
            { role: 'admin', departmentIds: [] },
          ),
        );
        void editing.catch(() => undefined);
        await expect
          .poll(async () => {
            const blocked = await owner.db.execute(
              sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted`,
            );
            return blocked[0]?.count;
          })
          .toBe(1);
        await tx
          .select()
          .from(userBrandRoles)
          .where(eq(userBrandRoles.userId, user.id))
          .for('update');
      });
      const held = await Promise.allSettled([holding]);
      const edited = await Promise.allSettled([editing]);
      if (held[0]?.status === 'rejected') throw held[0].reason;
      expect(held[0]).toMatchObject({ status: 'fulfilled' });
      if (edited[0]?.status === 'rejected') throw edited[0].reason;
      expect(edited[0]).toMatchObject({ status: 'fulfilled' });
      expect((await owner.db.select().from(userBrandRoles))[0]).toMatchObject({
        source: 'manual',
        role: 'admin',
      });
    });

    it('marks a token revoked when its family disappears before token registration', async () => {
      const store = new RefreshStore(runtime.redis);
      const { familyId } = await store.createFamily({ userId: ADMIN, userAgent: undefined });
      await store.revokeFamily(familyId);
      const sessionId = newSessionId();
      await store.registerSession(familyId, sessionId);
      expect(await store.isSessionRevoked(sessionId)).toBe(true);
    });
    it('does not mint a stale session while the final SSO role removal is committing', async () => {
      const { user } = await service.signIn(assertion());
      await owner.db
        .update(ssoConnections)
        .set({ defaultAccess: null })
        .where(eq(ssoConnections.id, CONNECTION));
      let releasePublication!: () => void;
      let publicationStarted!: () => void;
      const entered = new Promise<void>((resolve) => {
        publicationStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      const original = runtime.redis.publish;
      runtime.redis.publish = async (channel, message) => {
        const subscribers = await original.call(runtime.redis, channel, message);
        if (channel === PRINCIPAL_REVOKED_CHANNEL) {
          publicationStarted();
          await released;
        }
        return subscribers;
      };
      try {
        const syncing = service.signIn(assertion({ groups: [] })).then(
          () => null,
          (error: unknown) => error,
        );
        await entered;
        const opening = sessions.open({ userId: user.id, userAgent: 'concurrent-login' });
        // The Redis boundary holds the writer before commit, giving a concurrent
        // reader time to reach the old committed roles or the database lock.
        await Promise.race([opening, new Promise((resolve) => setTimeout(resolve, 150))]);
        releasePublication();
        expect(await syncing).toMatchObject({ auth: { code: 'sso-no-access' } });
        expect(await opening).toBeNull();
      } finally {
        releasePublication();
        runtime.redis.publish = original;
      }
    });
  },
);
