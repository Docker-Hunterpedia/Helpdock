import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EmailMessage, EmailSender } from '@helpdock/channels';
import type { Env } from '@helpdock/config';
import {
  auditLog,
  brands,
  createDb,
  type DbHandle,
  departments,
  userBrandRoles,
  users,
  withSystem,
} from '@helpdock/db';
import type { StaffList, StaffMember } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { generate } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PRINCIPAL_REVOKED_CHANNEL,
  trustedDeviceKey,
  userFamiliesKey,
} from '../auth/redis-keys.js';
import { REFRESH_COOKIE } from '../auth/session/cookies.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { anonymisedEmail, FORMER_STAFF_NAME } from './anonymise.js';

/**
 * The whole of M0-06 over HTTP, against a real Postgres and a real Redis.
 *
 * The unit suites prove the matrix decides correctly. This proves the effects
 * of DOMAIN-RULES §12 actually happen: a token that stops working when another
 * is sent, a refresh that fails after a role change, a deactivated account that
 * cannot sign in, a deleted one whose audit rows survive it, and a Team Leader
 * who cannot reach another department's agent.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 13).toString('base64');
const APP_URL = 'https://support.example.com';
const NEW_PASSWORD = 'a brand new password';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the staff integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

class CollectingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  last(): EmailMessage {
    const message = this.sent.at(-1);
    if (message === undefined) {
      throw new Error('no email was sent');
    }

    return message;
  }
}

/** The link in an invitation, as the person who received it would follow it. */
const tokenIn = (message: EmailMessage): string => {
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(message.text);
  if (match?.[1] === undefined) {
    throw new Error(`no invite link in:\n${message.text}`);
  }

  return match[1];
};

describe.skipIf(!hasDocker)('staff and roles', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let supportId: string;
  let billingId: string;
  /** A second brand, so a cross-brand membership can be exercised. */
  let otherBrandId: string;
  const email = new CollectingEmailSender();

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
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
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const bearer = (accessToken: string): Record<string, string> => ({
    authorization: `Bearer ${accessToken}`,
  });

  const cookieOf = (
    response: Awaited<ReturnType<typeof request>>,
    name: string,
  ): string | undefined => response.cookies.find((cookie) => cookie.name === name)?.value;

  /** The seeded install admin, signed in through password and second factor. */
  const signInAsAdmin = async (): Promise<string> => {
    const first = await request('POST', '/api/auth/sign-in', {
      body: { email: seeded.email, password: seeded.password },
    });
    const second = await request('POST', '/api/auth/totp', {
      body: {
        challengeId: (first.json() as { challengeId: string }).challengeId,
        code: await generate({ secret: seeded.totpSecret ?? '', period: 30 }),
        trustDevice: false,
      },
    });

    return (second.json() as { accessToken: string }).accessToken;
  };

  const signInWithPassword = async (address: string, password: string) =>
    request('POST', '/api/auth/sign-in', { body: { email: address, password } });

  const staffBase = (): string => `/api/brands/${seeded.brandId}/staff`;

  const invite = async (
    token: string,
    body: { email: string; role: string; departmentIds: string[] },
  ) => request('POST', `${staffBase()}/invites`, { body, headers: bearer(token) });

  const listStaff = async (token: string, search?: string): Promise<StaffList> => {
    const response = await request(
      'GET',
      search === undefined ? staffBase() : `${staffBase()}?search=${encodeURIComponent(search)}`,
      { headers: bearer(token) },
    );
    expect(response.statusCode).toBe(200);

    return response.json() as StaffList;
  };

  /** Invites an address and follows the link all the way to a working account. */
  const inviteAndAccept = async (
    token: string,
    address: string,
    { role = 'agent', departmentIds = [] as string[], name = 'A Person' } = {},
  ): Promise<{ member: StaffMember; accessToken: string; refreshCookie: string }> => {
    const invited = await invite(token, { email: address, role, departmentIds });
    expect(invited.statusCode).toBe(201);

    const accepted = await request('POST', `/api/auth/invites/${tokenIn(email.last())}/accept`, {
      body: { name, password: NEW_PASSWORD, locale: 'en' },
    });
    expect(accepted.statusCode).toBe(201);

    return {
      member: invited.json() as StaffMember,
      accessToken: (accepted.json() as { accessToken: string }).accessToken,
      refreshCookie: cookieOf(accepted, REFRESH_COOKIE) ?? '',
    };
  };

  /** One row of the staff list, by address. */
  const member = async (token: string, address: string): Promise<StaffMember> => {
    const [row] = (await listStaff(token, address)).staff;
    if (row === undefined) {
      throw new Error(`no staff row for ${address}`);
    }

    return row;
  };

  const auditActions = async (targetId: string): Promise<string[]> =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const rows = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.targetId, targetId))
        .orderBy(auditLog.createdAt);

      return rows.map((row) => row.action);
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
    app = await createApiApp({ runtime, emailSender: email });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });

    const [otherBrand] = await runtime.db
      .insert(brands)
      .values({ name: 'Helpdock Second', prefix: 'HDS' })
      .returning({ id: brands.id });
    otherBrandId = otherBrand?.id ?? '';
    await withSystem(runtime.db, otherBrandId, async (tx) => {
      await tx
        .insert(userBrandRoles)
        .values({ userId: seeded.userId, brandId: otherBrandId, role: 'admin' });
    });

    // M1-01 creates departments through admin; M0-06 only needs them to exist.
    [supportId, billingId] = await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const rows = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });

      return [
        rows.find((row) => row.name === 'Support')?.id ?? '',
        rows.find((row) => row.name === 'Billing')?.id ?? '',
      ];
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    email.sent.length = 0;
    await runtime.settings.set('roles.viewerEnabled', true, { updatedBy: 'integration-test' });

    const rateKeys = await runtime.redis.keys('auth:rate:*');
    if (rateKeys.length > 0) {
      await runtime.redis.del(...rateKeys);
    }
  });

  // ------------------------------------------------------------------

  describe('the invitation lifecycle', () => {
    it('invites, emails a link, and lists the person as a pending invite', async () => {
      const token = await signInAsAdmin();
      const address = `first.${Date.now()}@example.com`;

      const response = await invite(token, {
        email: address,
        role: 'agent',
        departmentIds: [supportId],
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        email: address,
        role: 'agent',
        status: 'invited',
        departments: [{ id: supportId, name: 'Support' }],
      });

      const message = email.last();
      expect(message.to.address).toBe(address);
      expect(message.subject).toContain('Helpdock Dev');

      const listed = await listStaff(token, address);
      const member = listed.staff[0];
      expect(member?.status).toBe('invited');
      expect(member?.invitedAt).not.toBeNull();
      expect(member?.invitationExpiresAt).not.toBeNull();
    });

    it('reads the invitation without spending it, then spends it once', async () => {
      const token = await signInAsAdmin();
      const address = `preview.${Date.now()}@example.com`;
      await invite(token, { email: address, role: 'agent', departmentIds: [billingId] });
      const link = tokenIn(email.last());

      const first = await request('GET', `/api/auth/invites/${link}`);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        email: address,
        role: 'agent',
        brandName: 'Helpdock Dev',
        inviterName: 'Dev Admin',
        departments: ['Billing'],
      });

      // Reading it again still works: a preview must not cost an invitation.
      expect((await request('GET', `/api/auth/invites/${link}`)).statusCode).toBe(200);

      const accepted = await request('POST', `/api/auth/invites/${link}/accept`, {
        body: { name: 'Nadia Karam', password: NEW_PASSWORD, locale: 'ar' },
      });
      expect(accepted.statusCode).toBe(201);
      expect(accepted.json()).toMatchObject({ kind: 'session' });

      // Spent: the same link cannot be read or accepted again.
      expect((await request('GET', `/api/auth/invites/${link}`)).statusCode).toBe(410);
      expect(
        (
          await request('POST', `/api/auth/invites/${link}/accept`, {
            body: { name: 'Someone Else', password: NEW_PASSWORD, locale: 'en' },
          })
        ).statusCode,
      ).toBe(410);
    });

    it('writes staff.invited and staff.invite.accepted', async () => {
      const token = await signInAsAdmin();
      const { member } = await inviteAndAccept(token, `audit.${Date.now()}@example.com`);

      await expect(auditActions(member.userId)).resolves.toEqual([
        'staff.invited',
        'staff.invite.accepted',
      ]);
    });

    it('resending invalidates the link it replaces', async () => {
      const token = await signInAsAdmin();
      const address = `resend.${Date.now()}@example.com`;
      const invited = await invite(token, { email: address, role: 'agent', departmentIds: [] });
      const first = tokenIn(email.last());

      const resent = await request(
        'POST',
        `${staffBase()}/invites/${(invited.json() as StaffMember).userId}/resend`,
        { headers: bearer(token) },
      );
      expect(resent.statusCode).toBe(204);

      const second = tokenIn(email.last());
      expect(second).not.toBe(first);
      expect((await request('GET', `/api/auth/invites/${first}`)).statusCode).toBe(410);
      expect((await request('GET', `/api/auth/invites/${second}`)).statusCode).toBe(200);
    });

    it('revoking removes the account that was only ever that invitation', async () => {
      const token = await signInAsAdmin();
      const address = `revoke.${Date.now()}@example.com`;
      const invited = await invite(token, { email: address, role: 'agent', departmentIds: [] });
      const { userId } = invited.json() as StaffMember;
      const link = tokenIn(email.last());

      const revoked = await request('DELETE', `${staffBase()}/invites/${userId}`, {
        headers: bearer(token),
      });

      expect(revoked.statusCode).toBe(204);
      expect((await request('GET', `/api/auth/invites/${link}`)).statusCode).toBe(410);

      const rows = await runtime.db.select().from(users).where(eq(users.id, userId));
      expect(rows).toHaveLength(0);
    });

    it('refuses to invite the same address into the brand twice', async () => {
      const token = await signInAsAdmin();
      const address = `twice.${Date.now()}@example.com`;
      await invite(token, { email: address, role: 'agent', departmentIds: [] });

      const again = await invite(token, { email: address, role: 'agent', departmentIds: [] });

      expect(again.statusCode).toBe(409);
    });

    it('refuses a department that belongs to no brand of this install', async () => {
      const token = await signInAsAdmin();

      const response = await invite(token, {
        email: `stranger.${Date.now()}@example.com`,
        role: 'agent',
        departmentIds: ['0199f4b2-6a91-7c27-9a1f-0000000000ff'],
      });

      expect(response.statusCode).toBe(400);
    });

    it('answers 410 for a token that was never issued here', async () => {
      expect((await request('GET', '/api/auth/invites/not-a-real-token')).statusCode).toBe(410);
    });

    /**
     * An account that already works here has a password, and a link that could
     * set a new one would be a way to take over somebody else's account with an
     * invitation. It gains the role and appears as active, with nothing sent.
     */
    it('adds an existing account to another brand without inviting it again', async () => {
      const token = await signInAsAdmin();
      const address = `crossbrand.${Date.now()}@example.com`;
      await inviteAndAccept(token, address);

      email.sent.length = 0;
      const added = await request('POST', `/api/brands/${otherBrandId}/staff/invites`, {
        body: { email: address, role: 'agent', departmentIds: [] },
        headers: bearer(token),
      });

      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ status: 'active', invitedAt: null });
      expect(email.sent).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------

  describe('changing a role', () => {
    it('publishes principal.revoked and makes the old refresh token fail', async () => {
      const token = await signInAsAdmin();
      const { member, refreshCookie } = await inviteAndAccept(
        token,
        `rolechange.${Date.now()}@example.com`,
      );

      const listener = new Redis(redisContainer.getConnectionUrl());
      try {
        // The handler is attached and the subscription awaited *before* the
        // change is made: a `SUBSCRIBE` still in flight would miss the message
        // and this would hang until the timeout rather than fail.
        const revoked = new Promise<string>((resolve) => {
          listener.on('message', (_channel, message) => {
            resolve(message);
          });
        });
        await listener.subscribe(PRINCIPAL_REVOKED_CHANNEL);

        const patched = await request('PATCH', `${staffBase()}/${member.userId}`, {
          body: { role: 'viewer', departmentIds: [] },
          headers: bearer(token),
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.json()).toMatchObject({ role: 'viewer', departments: 'all' });

        await expect(revoked).resolves.toContain(member.userId);
      } finally {
        await listener.quit();
      }

      const refreshed = await request('POST', '/api/auth/refresh', {
        headers: { cookie: `${REFRESH_COOKIE}=${refreshCookie}` },
      });
      expect(refreshed.statusCode).toBe(401);

      await expect(auditActions(member.userId)).resolves.toContain('staff.role.changed');
    });

    it('refuses an empty change rather than revoking sessions for nothing', async () => {
      const token = await signInAsAdmin();
      const { member } = await inviteAndAccept(token, `nochange.${Date.now()}@example.com`);

      const response = await request('PATCH', `${staffBase()}/${member.userId}`, {
        body: {},
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses to change your own role', async () => {
      const token = await signInAsAdmin();

      const response = await request('PATCH', `${staffBase()}/${seeded.userId}`, {
        body: { role: 'agent', departmentIds: [supportId] },
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { staff: { reason: 'self' } } });
    });
  });

  // ------------------------------------------------------------------

  describe('deactivation', () => {
    it('blocks sign-in, revokes the sessions, and is reversible', async () => {
      const token = await signInAsAdmin();
      const address = `deactivate.${Date.now()}@example.com`;
      const { member } = await inviteAndAccept(token, address);

      await expect(
        signInWithPassword(address, NEW_PASSWORD).then((r) => r.statusCode),
      ).resolves.toBe(201);

      const deactivated = await request('POST', `${staffBase()}/${member.userId}/deactivate`, {
        headers: bearer(token),
      });
      expect(deactivated.statusCode).toBe(201);
      expect(deactivated.json()).toMatchObject({ status: 'deactivated' });
      await expect(runtime.redis.smembers(userFamiliesKey(member.userId))).resolves.toEqual([]);

      const refused = await signInWithPassword(address, NEW_PASSWORD);
      expect(refused.statusCode).toBe(401);

      const reactivated = await request('POST', `${staffBase()}/${member.userId}/reactivate`, {
        headers: bearer(token),
      });
      expect(reactivated.statusCode).toBe(201);
      expect(reactivated.json()).toMatchObject({ status: 'active' });
      await expect(
        signInWithPassword(address, NEW_PASSWORD).then((r) => r.statusCode),
      ).resolves.toBe(201);

      await expect(auditActions(member.userId)).resolves.toEqual(
        expect.arrayContaining(['staff.deactivated', 'staff.reactivated']),
      );
    });

    it('forgets every browser the account had trusted', async () => {
      const token = await signInAsAdmin();
      const address = `trusted.${Date.now()}@example.com`;
      const { member } = await inviteAndAccept(token, address);

      // Enrol a second factor and trust this browser, so there is something to
      // revoke: a deactivated person must not keep a browser that skips it.
      await runtime.redis.set(trustedDeviceKey(member.userId, 'some-nonce-hash'), '1', 'EX', 600);

      await request('POST', `${staffBase()}/${member.userId}/deactivate`, {
        headers: bearer(token),
      });

      await expect(runtime.redis.keys(trustedDeviceKey(member.userId, '*'))).resolves.toEqual([]);
    });

    /**
     * The seeded account is this install's only install admin, and nobody may
     * act on their own membership — so the refusal has to be reached by a
     * *second* brand administrator acting on them.
     */
    it('refuses to deactivate the last install admin', async () => {
      const token = await signInAsAdmin();
      const other = await inviteAndAccept(token, `secondadmin.${Date.now()}@example.com`, {
        role: 'admin',
        name: 'Second Admin',
      });

      const refused = await request('POST', `${staffBase()}/${seeded.userId}/deactivate`, {
        headers: bearer(other.accessToken),
      });

      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: { staff: { reason: 'last-install-admin' } },
      });

      // With a second install admin in place the floor no longer applies.
      await runtime.db
        .update(users)
        .set({ installAdmin: true })
        .where(eq(users.id, other.member.userId));
      try {
        const allowed = await request('POST', `${staffBase()}/${seeded.userId}/deactivate`, {
          headers: bearer(other.accessToken),
        });
        expect(allowed.statusCode).toBe(201);
      } finally {
        await request('POST', `${staffBase()}/${seeded.userId}/reactivate`, {
          headers: bearer(other.accessToken),
        });
        await runtime.db
          .update(users)
          .set({ installAdmin: false })
          .where(eq(users.id, other.member.userId));
      }
    });
  });

  // ------------------------------------------------------------------

  describe('removal from one brand', () => {
    /**
     * A session is only minted for an account that holds a brand role, so
     * taking the last install admin's role away would lock the operator out of
     * their own install with no way back in.
     */
    it('refuses to take the last install admin\u2019s only role away', async () => {
      const token = await signInAsAdmin();
      const other = await inviteAndAccept(token, `remover.${Date.now()}@example.com`, {
        role: 'admin',
        name: 'Another Admin',
      });

      const response = await request('DELETE', `${staffBase()}/${seeded.userId}/role`, {
        headers: bearer(other.accessToken),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { staff: { reason: 'last-install-admin' } },
      });
    });

    it('refuses to demote the last install admin to a role the install can turn off', async () => {
      const token = await signInAsAdmin();
      const other = await inviteAndAccept(token, `demoter.${Date.now()}@example.com`, {
        role: 'admin',
        name: 'Yet Another Admin',
      });

      const response = await request('PATCH', `${staffBase()}/${seeded.userId}`, {
        body: { role: 'viewer', departmentIds: [] },
        headers: bearer(other.accessToken),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { staff: { reason: 'last-install-admin' } },
      });
    });

    it('takes the role away and ends every session', async () => {
      const token = await signInAsAdmin();
      const { member, refreshCookie } = await inviteAndAccept(
        token,
        `removed.${Date.now()}@example.com`,
      );

      const removed = await request('DELETE', `${staffBase()}/${member.userId}/role`, {
        headers: bearer(token),
      });

      expect(removed.statusCode).toBe(204);
      expect((await listStaff(token)).staff.some((row) => row.userId === member.userId)).toBe(
        false,
      );
      expect(
        (
          await request('POST', '/api/auth/refresh', {
            headers: { cookie: `${REFRESH_COOKIE}=${refreshCookie}` },
          })
        ).statusCode,
      ).toBe(401);
    });
  });

  // ------------------------------------------------------------------

  describe('deleting an account', () => {
    it('refuses while the account is still active', async () => {
      const token = await signInAsAdmin();
      const { member } = await inviteAndAccept(token, `stillactive.${Date.now()}@example.com`);

      const response = await request('DELETE', `/api/install/staff/${member.userId}`, {
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(409);
    });

    it('refuses to delete the account making the request', async () => {
      const token = await signInAsAdmin();

      const response = await request('DELETE', `/api/install/staff/${seeded.userId}`, {
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { staff: { reason: 'self' } } });
    });

    it('anonymises the row, keeps the audit trail, and leaves nothing to sign in with', async () => {
      const token = await signInAsAdmin();
      const address = `deleted.${Date.now()}@example.com`;
      const { member } = await inviteAndAccept(token, address);
      await request('POST', `${staffBase()}/${member.userId}/deactivate`, {
        headers: bearer(token),
      });

      const response = await request('DELETE', `/api/install/staff/${member.userId}`, {
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(204);

      const [row] = await runtime.db.select().from(users).where(eq(users.id, member.userId));
      expect(row?.name).toBe(FORMER_STAFF_NAME);
      expect(row?.email).toBe(anonymisedEmail(member.userId));
      expect(row?.passwordHash).toBeNull();
      expect(row?.totpEnabled).toBe(false);
      expect(row?.recoveryCodesHashed).toEqual([]);

      // The audit rows about them are still there, which is the point of
      // keeping the row at all.
      await expect(auditActions(member.userId)).resolves.toEqual(
        expect.arrayContaining(['staff.invited', 'staff.deactivated']),
      );

      const refused = await signInWithPassword(address, NEW_PASSWORD);
      expect(refused.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------

  describe('a Team Leader', () => {
    it('cannot manage an agent of a department they do not lead', async () => {
      const admin = await signInAsAdmin();
      const leaderAddress = `leader.${Date.now()}@example.com`;
      const leader = await inviteAndAccept(admin, leaderAddress, {
        role: 'teamLeader',
        departmentIds: [supportId],
        name: 'Team Leader',
      });
      const billingAgent = await inviteAndAccept(admin, `billing.${Date.now()}@example.com`, {
        role: 'agent',
        departmentIds: [billingId],
      });
      const supportAgent = await inviteAndAccept(admin, `support.${Date.now()}@example.com`, {
        role: 'agent',
        departmentIds: [supportId],
      });

      const refused = await request('PATCH', `${staffBase()}/${billingAgent.member.userId}`, {
        body: { departmentIds: [supportId] },
        headers: bearer(leader.accessToken),
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: { staff: { reason: 'out-of-scope' } } });

      // Their own department's agent is fine.
      const allowed = await request('PATCH', `${staffBase()}/${supportAgent.member.userId}`, {
        body: { role: 'viewer' },
        headers: bearer(leader.accessToken),
      });
      expect(allowed.statusCode).toBe(200);
    });

    /**
     * `users` is a global table, so an address resolves across every brand.
     * Attaching a role to an account that already exists elsewhere and then
     * acting on it is how a brand-scoped permission would reach out of its
     * brand, so it is an Admin's decision and nobody else's.
     */
    it('cannot attach an account that already exists on this install', async () => {
      const admin = await signInAsAdmin();
      const leader = await inviteAndAccept(admin, `leader3.${Date.now()}@example.com`, {
        role: 'teamLeader',
        departmentIds: [supportId],
      });
      const elsewhere = `elsewhere.${Date.now()}@example.com`;
      await inviteAndAccept(admin, elsewhere);
      await request('DELETE', `${staffBase()}/${(await member(admin, elsewhere)).userId}/role`, {
        headers: bearer(admin),
      });

      const response = await invite(leader.accessToken, {
        email: elsewhere,
        role: 'agent',
        departmentIds: [supportId],
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { staff: { reason: 'out-of-scope' } } });
    });

    /**
     * Deactivation is the one action whose effect leaves the brand: it decides
     * whether somebody may sign in to the install at all.
     */
    it('cannot deactivate anybody, even an agent in their own departments', async () => {
      const admin = await signInAsAdmin();
      const leader = await inviteAndAccept(admin, `leader4.${Date.now()}@example.com`, {
        role: 'teamLeader',
        departmentIds: [supportId],
      });
      const agent = await inviteAndAccept(admin, `theiragent.${Date.now()}@example.com`, {
        role: 'agent',
        departmentIds: [supportId],
      });

      const response = await request('POST', `${staffBase()}/${agent.member.userId}/deactivate`, {
        headers: bearer(leader.accessToken),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { staff: { reason: 'out-of-scope' } } });
    });

    it('cannot invite an admin', async () => {
      const admin = await signInAsAdmin();
      const leader = await inviteAndAccept(admin, `leader2.${Date.now()}@example.com`, {
        role: 'teamLeader',
        departmentIds: [supportId],
      });

      const response = await invite(leader.accessToken, {
        email: `promoted.${Date.now()}@example.com`,
        role: 'admin',
        departmentIds: [],
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ------------------------------------------------------------------

  describe('the Viewer toggle', () => {
    it('refuses the role while it is off, and stops an existing Viewer signing in', async () => {
      const token = await signInAsAdmin();
      const address = `viewer.${Date.now()}@example.com`;
      await inviteAndAccept(token, address, { role: 'viewer' });

      await runtime.settings.set('roles.viewerEnabled', false, { updatedBy: 'integration-test' });

      const refusedInvite = await invite(token, {
        email: `newviewer.${Date.now()}@example.com`,
        role: 'viewer',
        departmentIds: [],
      });
      expect(refusedInvite.statusCode).toBe(409);
      expect(refusedInvite.json()).toMatchObject({
        error: { staff: { reason: 'viewer-disabled' } },
      });

      // An account whose only role was Viewer has nothing left to sign in to.
      const refusedSignIn = await signInWithPassword(address, NEW_PASSWORD);
      expect(refusedSignIn.statusCode).toBe(403);
      expect(refusedSignIn.json()).toMatchObject({ error: { auth: { code: 'no-account' } } });
    });
  });

  // ------------------------------------------------------------------

  describe('an agent', () => {
    it('cannot read the staff list at all', async () => {
      const admin = await signInAsAdmin();
      const agent = await inviteAndAccept(admin, `agent.${Date.now()}@example.com`, {
        role: 'agent',
        departmentIds: [supportId],
      });

      const response = await request('GET', staffBase(), {
        headers: bearer(agent.accessToken),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ------------------------------------------------------------------

  describe('a person’s own account', () => {
    it('changes a name and a language', async () => {
      const admin = await signInAsAdmin();
      const person = await inviteAndAccept(admin, `profile.${Date.now()}@example.com`);

      const response = await request('PATCH', '/api/me/profile', {
        body: { name: 'Renamed Person', locale: 'ar' },
        headers: bearer(person.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name: 'Renamed Person', locale: 'ar' });
    });

    it('changes a password, keeping this browser and ending the others', async () => {
      const admin = await signInAsAdmin();
      const address = `password.${Date.now()}@example.com`;
      const person = await inviteAndAccept(admin, address);

      // A second browser, which the change has to end.
      const second = await signInWithPassword(address, NEW_PASSWORD);
      const secondCookie = cookieOf(second, REFRESH_COOKIE) ?? '';

      const wrong = await request('POST', '/api/me/password', {
        body: { currentPassword: 'not the password', newPassword: 'another long password' },
        headers: bearer(person.accessToken),
      });
      expect(wrong.statusCode).toBe(401);

      const changed = await request('POST', '/api/me/password', {
        body: { currentPassword: NEW_PASSWORD, newPassword: 'another long password' },
        headers: {
          ...bearer(person.accessToken),
          cookie: `${REFRESH_COOKIE}=${person.refreshCookie}`,
        },
      });
      expect(changed.statusCode).toBe(204);

      expect(
        (
          await request('POST', '/api/auth/refresh', {
            headers: { cookie: `${REFRESH_COOKIE}=${secondCookie}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await request('POST', '/api/auth/refresh', {
            headers: { cookie: `${REFRESH_COOKIE}=${person.refreshCookie}` },
          })
        ).statusCode,
      ).toBe(201);
    });

    it('lists the browsers it is signed in on and signs one out', async () => {
      const admin = await signInAsAdmin();
      const address = `sessions.${Date.now()}@example.com`;
      const person = await inviteAndAccept(admin, address);
      await signInWithPassword(address, NEW_PASSWORD);

      const listed = await request('GET', '/api/me/sessions', {
        headers: {
          ...bearer(person.accessToken),
          cookie: `${REFRESH_COOKIE}=${person.refreshCookie}`,
        },
      });
      expect(listed.statusCode).toBe(200);
      const { sessions } = listed.json() as {
        sessions: { familyId: string; current: boolean }[];
      };
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((session) => session.current)).toHaveLength(1);

      const other = sessions.find((session) => !session.current)?.familyId ?? '';
      const revoked = await request('DELETE', `/api/me/sessions/${other}`, {
        headers: bearer(person.accessToken),
      });
      expect(revoked.statusCode).toBe(204);

      // Somebody else's family is refused the same way a missing one is.
      const stranger = await request(
        'DELETE',
        '/api/me/sessions/0199f4b2-6a91-7c27-9a1f-0000000000ee',
        { headers: bearer(person.accessToken) },
      );
      expect(stranger.statusCode).toBe(403);
    });

    it('refuses to turn the second factor off while the install requires it', async () => {
      const admin = await signInAsAdmin();
      const person = await inviteAndAccept(admin, `required.${Date.now()}@example.com`);
      await runtime.settings.set('auth.require2fa', true, { updatedBy: 'integration-test' });

      try {
        const response = await request('POST', '/api/me/totp/disable', {
          body: { code: '000000' },
          headers: bearer(person.accessToken),
        });

        // `totp-locked` shares this status, so the code is asserted too: the
        // refusal has to be the `require2fa` one this test is named for.
        expect(response.statusCode).toBe(429);
        expect(response.json()).toMatchObject({ error: { auth: { code: 'unavailable' } } });
      } finally {
        await runtime.settings.set('auth.require2fa', false, { updatedBy: 'integration-test' });
      }
    });

    /**
     * Six digits with a one-step window is three valid codes out of a million
     * at any instant. Sign-in spends a challenge for this; these routes have no
     * challenge, so the budget is the lock.
     */
    it('stops guessing at an authenticator code from inside a session', async () => {
      const admin = await signInAsAdmin();
      const person = await inviteAndAccept(admin, `guessing.${Date.now()}@example.com`);

      const attempts: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await request('POST', '/api/me/recovery-codes/regenerate', {
          body: { code: '000000' },
          headers: bearer(person.accessToken),
        });
        attempts.push(response.statusCode);
      }

      // Five attempts are spent as wrong codes; the rest are refused outright.
      expect(attempts.filter((status) => status === 401)).toHaveLength(5);
      expect(attempts.filter((status) => status === 429)).toHaveLength(2);
    });

    it('enrols, regenerates recovery codes with a live code, then turns it off', async () => {
      const admin = await signInAsAdmin();
      const person = await inviteAndAccept(admin, `enrol.${Date.now()}@example.com`);

      const enrolled = await request('POST', '/api/auth/totp/enrol', {
        headers: bearer(person.accessToken),
      });
      expect(enrolled.statusCode).toBe(201);
      const { secret } = enrolled.json() as { secret: string };

      const confirmed = await request('POST', '/api/auth/totp/confirm', {
        body: { code: await generate({ secret, period: 30 }) },
        headers: bearer(person.accessToken),
      });
      expect(confirmed.statusCode).toBe(201);
      const first = (confirmed.json() as { recoveryCodes: string[] }).recoveryCodes;
      expect(first).toHaveLength(10);

      const regenerated = await request('POST', '/api/me/recovery-codes/regenerate', {
        body: { code: await generate({ secret, period: 30 }) },
        headers: bearer(person.accessToken),
      });
      expect(regenerated.statusCode).toBe(201);
      expect((regenerated.json() as { recoveryCodes: string[] }).recoveryCodes).not.toEqual(first);

      const wrongCode = await request('POST', '/api/me/totp/disable', {
        body: { code: '000000' },
        headers: bearer(person.accessToken),
      });
      expect(wrongCode.statusCode).toBe(401);

      const disabled = await request('POST', '/api/me/totp/disable', {
        body: { code: await generate({ secret, period: 30 }) },
        headers: bearer(person.accessToken),
      });
      expect(disabled.statusCode).toBe(204);

      const profile = await request('GET', '/api/me/profile', {
        headers: bearer(person.accessToken),
      });
      expect(profile.json()).toMatchObject({ twoFactorEnabled: false, recoveryCodesLeft: 0 });
    });
  });

  // ------------------------------------------------------------------

  describe('the departments list', () => {
    it('names this brand’s departments and nothing else', async () => {
      const token = await signInAsAdmin();

      const response = await request('GET', `/api/brands/${seeded.brandId}/departments`, {
        headers: bearer(token),
      });

      expect(response.statusCode).toBe(200);
      expect(
        (response.json() as { departments: { name: string }[] }).departments.map((d) => d.name),
      ).toEqual(['Billing', 'Support']);
    });
  });

  // ------------------------------------------------------------------

  describe('searching', () => {
    it('matches part of a name or an address, and treats a wildcard as a character', async () => {
      const token = await signInAsAdmin();
      const address = `searchable.${Date.now()}@example.com`;
      await inviteAndAccept(token, address, { name: 'Searchable Person' });

      await expect(listStaff(token, 'Searchable').then((l) => l.staff.length)).resolves.toBe(1);
      await expect(listStaff(token, 'searchable.').then((l) => l.staff.length)).resolves.toBe(1);
      // A bare `%` would match everybody if it were passed through as a wildcard.
      await expect(listStaff(token, '%').then((l) => l.staff.length)).resolves.toBe(0);
    });
  });
});
