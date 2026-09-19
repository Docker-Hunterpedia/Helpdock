import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EmailMessage, EmailSender } from '@helpdock/channels';
import type { Env } from '@helpdock/config';
import {
  auditLog,
  brands,
  brandTicketSequenceName,
  createDb,
  type DbHandle,
  departments,
  INSTALL_SCOPE_BRAND_ID,
  seedBrandStatuses,
  ticketStatuses,
  tickets,
  userBrandRoles,
  withSystem,
} from '@helpdock/db';
import type { Brand, DepartmentSummaryList, EligibleMemberList, TeamList } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, inArray, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';

/**
 * The whole of M1-01 over HTTP, against a real Postgres and a real Redis.
 *
 * The unit suites prove the rules decide correctly. This proves the effects
 * actually happen: that a Team Leader's refusal survives the guards and the
 * policies, that a brand another install admin created comes with a working
 * ticket sequence and an administrator, that the last department cannot be
 * deleted, and that one brand's departments and teams are invisible to another.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 17).toString('base64');
const APP_URL = 'https://support.example.com';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the brands integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

/** Twelve characters, which is the only rule `passwordSchema` enforces. */
const COLLEAGUE_PASSWORD = 'a colleague password';

/**
 * Prefixes are unique install-wide and this suite makes several brands, so they
 * are counted rather than timed: two brands drawn in the same millisecond would
 * collide.
 */
let nextPrefix = 0;
const freshPrefix = (): string => {
  nextPrefix += 1;

  return `NB${String(nextPrefix).padStart(3, '0')}`;
};

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

describe.skipIf(!hasDocker)('brands, departments and teams', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  /** The owner role connected to `helpdock` itself, for the sequences it owns. */
  let ownerDb: DbHandle;
  let seeded: SeededInstall;
  let adminToken: string;

  /** Departments the seeded brand starts every test with. */
  let billingId = '';
  let technicalId = '';
  /** A Team Leader who leads Billing and nothing else. */
  let leaderId = '';
  let leaderToken = '';
  /** An Agent in Technical, so eligibility has somebody to refuse. */
  let technicalAgentId = '';
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
    { body, token }: { body?: unknown; token?: string } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const signIn = async (
    address: string,
    password: string,
    totpSecret?: string,
  ): Promise<string> => {
    const first = await request('POST', '/api/auth/sign-in', {
      body: { email: address, password },
    });
    const firstBody = first.json() as { accessToken?: string; challengeId?: string };
    if (firstBody.accessToken !== undefined) {
      return firstBody.accessToken;
    }

    const second = await request('POST', '/api/auth/totp', {
      body: {
        challengeId: firstBody.challengeId,
        code: await generate({ secret: totpSecret ?? '', period: 30 }),
        trustDevice: false,
      },
    });

    return (second.json() as { accessToken: string }).accessToken;
  };

  const base = (brandId = seeded.brandId): string => `/api/brands/${brandId}/departments`;

  const listDepartments = async (token = adminToken): Promise<DepartmentSummaryList> => {
    const response = await request('GET', base(), { token });
    expect(response.statusCode).toBe(200);

    return response.json() as DepartmentSummaryList;
  };

  const teamsOf = async (departmentId: string, token = adminToken): Promise<TeamList> => {
    const response = await request('GET', `${base()}/${departmentId}/teams`, { token });
    expect(response.statusCode).toBe(200);

    return response.json() as TeamList;
  };

  const refusalIn = (response: { json: () => unknown }): string | undefined =>
    (response.json() as { error?: { ticketing?: { reason?: string } } }).error?.ticketing?.reason;

  const auditActions = async (targetId: string, brandId = seeded.brandId): Promise<string[]> =>
    withSystem(runtime.db, brandId, async (tx) => {
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
    ownerDb = createDb({ url: env.DATABASE_MIGRATION_URL, max: 2 });
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
    adminToken = await signIn(seeded.email, seeded.password, seeded.totpSecret ?? '');

    // Two colleagues with working passwords, invited the way a real one would
    // be. Their roles are rewritten per test, because the department ids they
    // name are created per test. One at a time, because each one's token is
    // read out of the last message the sender collected.
    leaderId = await inviteAndAccept('leader@example.com', 'Billing Leader');
    technicalAgentId = await inviteAndAccept('tech-agent@example.com', 'Tech Agent');
  }, 300_000);

  /** Invites an address and follows the link all the way to a working account. */
  const inviteAndAccept = async (address: string, name: string): Promise<string> => {
    const invited = await request('POST', `/api/brands/${seeded.brandId}/staff/invites`, {
      token: adminToken,
      body: { email: address, role: 'agent', departmentIds: [] },
    });
    expect(invited.statusCode).toBe(201);

    const accepted = await request('POST', `/api/auth/invites/${tokenIn(email.last())}/accept`, {
      body: { name, password: COLLEAGUE_PASSWORD, locale: 'en' },
    });
    expect(accepted.statusCode).toBe(201);

    return (invited.json() as { userId: string }).userId;
  };

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await ownerDb?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  /**
   * Every test starts from the same two departments and the same two colleagues,
   * because most of them change one of the two.
   */
  beforeEach(async () => {
    email.sent.length = 0;
    // Signing in twice per test is well inside the per-address limit, but the
    // suite as a whole is not, so the buckets are cleared the way the staff
    // suite clears them.
    const rateKeys = await runtime.redis.keys('auth:rate:*');
    if (rateKeys.length > 0) {
      await runtime.redis.del(...rateKeys);
    }

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      // Tickets first: `tickets.department_id` is `ON DELETE restrict`, which
      // is the whole point of the in-use refusal below.
      await tx.delete(tickets);
      await tx.delete(departments);
      const rows = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Billing', sortOrder: 0 },
          { brandId: seeded.brandId, name: 'Technical', sortOrder: 1 },
        ])
        .returning({ id: departments.id, name: departments.name });

      billingId = rows.find((row) => row.name === 'Billing')?.id ?? '';
      technicalId = rows.find((row) => row.name === 'Technical')?.id ?? '';
    });

    // The memberships name the department ids this test's fixture just made, so
    // they are rewritten every time rather than seeded once — and the token is
    // taken afterwards, because an access token carries the claims it was
    // minted with (DOMAIN-RULES §1.6).
    // Written from scratch rather than updated, because a test may have removed
    // the role altogether and the next one has to start from the same brand.
    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      await tx
        .delete(userBrandRoles)
        .where(inArray(userBrandRoles.userId, [leaderId, technicalAgentId]));
      await tx.insert(userBrandRoles).values([
        {
          userId: leaderId,
          brandId: seeded.brandId,
          role: 'team_leader',
          departmentIds: [billingId],
        },
        {
          userId: technicalAgentId,
          brandId: seeded.brandId,
          role: 'agent',
          departmentIds: [technicalId],
        },
      ]);
    });

    leaderToken = await signIn('leader@example.com', COLLEAGUE_PASSWORD);
  });

  // ------------------------------------------------------------------

  describe('reading', () => {
    it('lists the brand’s departments in their sort order with their counts', async () => {
      const { departments: rows } = await listDepartments();

      expect(rows.map((row) => row.name)).toEqual(['Billing', 'Technical']);
      expect(rows[0]).toMatchObject({ sortOrder: 0, teamCount: 0, memberCount: 0 });
    });

    it('resolves the default team’s name so the list can print it', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';
      await request('PATCH', `${base()}/${billingId}`, {
        token: adminToken,
        body: { defaultTeamId: teamId },
      });

      const [billing, technical] = (await listDepartments()).departments;
      expect(billing).toMatchObject({ defaultTeamId: teamId, defaultTeamName: 'Front line' });
      expect(technical).toMatchObject({ defaultTeamId: null, defaultTeamName: null });
    });
  });

  describe('creating and editing', () => {
    it('creates one at the end of the list and audits it', async () => {
      const created = await request('POST', base(), {
        token: adminToken,
        body: { name: 'Sales', nameAr: 'المبيعات' },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ name: 'Sales', nameAr: 'المبيعات', sortOrder: 2 });
      expect(await auditActions((created.json() as { id: string }).id)).toEqual([
        'department.created',
      ]);
    });

    it('refuses a duplicate name with a code the screen can translate', async () => {
      const response = await request('POST', base(), {
        token: adminToken,
        body: { name: 'billing' },
      });

      expect(response.statusCode).toBe(409);
      expect(refusalIn(response)).toBe('name-taken');
    });

    it('lets a Team Leader rename a department they lead', async () => {
      const response = await request('PATCH', `${base()}/${billingId}`, {
        token: leaderToken,
        body: { name: 'Billing and payments' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name: 'Billing and payments' });
    });

    it('refuses a Team Leader a department outside their scope', async () => {
      const response = await request('PATCH', `${base()}/${technicalId}`, {
        token: leaderToken,
        body: { name: 'Theirs now' },
      });

      expect(response.statusCode).toBe(403);
      expect(refusalIn(response)).toBe('out-of-scope');
    });

    it('refuses a Team Leader creating or deleting a department at all', async () => {
      const created = await request('POST', base(), {
        token: leaderToken,
        body: { name: 'Sales' },
      });
      const deleted = await request('DELETE', `${base()}/${billingId}`, { token: leaderToken });

      expect(created.statusCode).toBe(403);
      expect(deleted.statusCode).toBe(403);
    });

    it('reorders the whole list and refuses a partial one', async () => {
      const reordered = await request('POST', `${base()}/reorder`, {
        token: adminToken,
        body: { departmentIds: [technicalId, billingId] },
      });

      expect(reordered.statusCode).toBe(201);
      expect(
        (reordered.json() as DepartmentSummaryList).departments.map((row) => row.name),
      ).toEqual(['Technical', 'Billing']);

      const partial = await request('POST', `${base()}/reorder`, {
        token: adminToken,
        body: { departmentIds: [billingId] },
      });

      expect(partial.statusCode).toBe(400);
    });
  });

  describe('deleting', () => {
    it('deletes one of several', async () => {
      const response = await request('DELETE', `${base()}/${technicalId}`, { token: adminToken });

      expect(response.statusCode).toBe(204);
      expect((await listDepartments()).departments.map((row) => row.name)).toEqual(['Billing']);
    });

    it('refuses a department tickets still belong to', async () => {
      // Written straight into the brand rather than through the ticket routes:
      // what is under test is the refusal, and M1-02 owns how a ticket is made.
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await seedBrandStatuses(tx, seeded.brandId);
        const [status] = await tx.select({ id: ticketStatuses.id }).from(ticketStatuses).limit(1);

        await tx.insert(tickets).values({
          brandId: seeded.brandId,
          departmentId: technicalId,
          number: Date.now() % 1_000_000,
          prefix: 'HD',
          subject: 'Filed under Technical',
          statusId: status?.id ?? '',
          channel: 'manual',
        });
      });

      const response = await request('DELETE', `${base()}/${technicalId}`, { token: adminToken });

      expect(response.statusCode).toBe(409);
      expect(refusalIn(response)).toBe('department-in-use');
      expect((await listDepartments()).departments.map((row) => row.name)).toContain('Technical');
    });

    it('refuses the brand’s last department', async () => {
      await request('DELETE', `${base()}/${technicalId}`, { token: adminToken });
      const response = await request('DELETE', `${base()}/${billingId}`, { token: adminToken });

      expect(response.statusCode).toBe(409);
      expect(refusalIn(response)).toBe('last-department');
    });
  });

  describe('teams and members', () => {
    it('creates a team, adds an eligible member, and counts them on the department', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      expect(created.statusCode).toBe(201);

      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';
      const added = await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: adminToken,
        body: { userId: seeded.userId },
      });

      expect(added.statusCode).toBe(201);
      expect((added.json() as TeamList).teams[0]?.members.map((member) => member.userId)).toEqual([
        seeded.userId,
      ]);

      const [billing] = (await listDepartments()).departments;
      expect(billing).toMatchObject({ teamCount: 1, memberCount: 1 });
    });

    it('refuses somebody whose departments do not reach this one', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';

      const response = await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: adminToken,
        body: { userId: technicalAgentId },
      });

      expect(response.statusCode).toBe(409);
      expect(refusalIn(response)).toBe('not-eligible');
    });

    it('never puts an address in the team list, which an Agent may read', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';
      await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: adminToken,
        body: { userId: seeded.userId },
      });

      const listed = await teamsOf(billingId);

      expect(listed.teams[0]?.members[0]).toMatchObject({ userId: seeded.userId });
      expect(listed.teams[0]?.members[0]).not.toHaveProperty('email');
    });

    it('renames a team over the wire', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';

      const renamed = await request('PATCH', `${base()}/${billingId}/teams/${teamId}`, {
        token: adminToken,
        body: { name: 'Tier 1' },
      });

      expect(renamed.statusCode).toBe(200);
      expect((renamed.json() as TeamList).teams.map((team) => team.name)).toEqual(['Tier 1']);
      expect(await auditActions(teamId)).toEqual(['team.created', 'team.updated']);
    });

    it('adding the same person twice is a no-op, not a failure', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';
      const add = () =>
        request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
          token: adminToken,
          body: { userId: seeded.userId },
        });

      await add();
      const twice = await add();

      expect(twice.statusCode).toBe(201);
      expect((twice.json() as TeamList).teams[0]?.members).toHaveLength(1);
    });

    it('drops a member from the list once their role in the brand is gone', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';
      await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: adminToken,
        body: { userId: leaderId },
      });
      expect((await teamsOf(billingId)).teams[0]?.members).toHaveLength(1);

      await request('DELETE', `/api/brands/${seeded.brandId}/staff/${leaderId}/role`, {
        token: adminToken,
      });

      // The row survives — the membership comes back with the role — but
      // nothing lists somebody who cannot work here.
      expect((await teamsOf(billingId)).teams[0]?.members).toEqual([]);
    });

    it('never offers a Team Leader an Admin, and refuses the write too', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';

      // Somebody the leader *may* manage, so the assertion below is about the
      // ceiling rather than about an empty brand.
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx
          .update(userBrandRoles)
          .set({ departmentIds: [billingId, technicalId] })
          .where(eq(userBrandRoles.userId, technicalAgentId));
      });

      const picker = await request('GET', `${base()}/${billingId}/eligible-members`, {
        token: leaderToken,
      });
      const offered = (picker.json() as EligibleMemberList).members.map((member) => member.userId);

      expect(offered).toContain(technicalAgentId);
      // The Admin is above the ceiling, and so is the leader themself: §1.2
      // says a Team Leader adds Agents and Viewers, nobody else.
      expect(offered).not.toContain(seeded.userId);
      expect(offered).not.toContain(leaderId);

      // DOMAIN-RULES §1.2: the ceiling is a permission answer, so 403 rather
      // than the 409 an unreachable colleague gets.
      const refused = await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: leaderToken,
        body: { userId: seeded.userId },
      });
      expect(refused.statusCode).toBe(403);
      expect(refusalIn(refused)).toBe('out-of-scope');

      // And the Admin may do what the Team Leader could not.
      const allowed = await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: adminToken,
        body: { userId: seeded.userId },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('refuses a Team Leader taking an Admin off a team', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';
      await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: adminToken,
        body: { userId: seeded.userId },
      });

      const response = await request(
        'DELETE',
        `${base()}/${billingId}/teams/${teamId}/members/${seeded.userId}`,
        { token: leaderToken },
      );

      expect(response.statusCode).toBe(403);
      expect(refusalIn(response)).toBe('out-of-scope');
      expect((await teamsOf(billingId)).teams[0]?.members).toHaveLength(1);
    });

    it('refuses a Team Leader the picker of a department they do not lead', async () => {
      const response = await request('GET', `${base()}/${technicalId}/eligible-members`, {
        token: leaderToken,
      });

      expect(response.statusCode).toBe(403);
      expect(refusalIn(response)).toBe('out-of-scope');
    });

    it('does not offer a deactivated colleague', async () => {
      await request('POST', `/api/brands/${seeded.brandId}/staff/${technicalAgentId}/deactivate`, {
        token: adminToken,
      });

      const response = await request('GET', `${base()}/${billingId}/eligible-members`, {
        token: adminToken,
      });
      const ids = (response.json() as EligibleMemberList).members.map((member) => member.userId);

      expect(ids).not.toContain(technicalAgentId);

      await request('POST', `/api/brands/${seeded.brandId}/staff/${technicalAgentId}/reactivate`, {
        token: adminToken,
      });
    });

    it('offers the picker only staff whose scope reaches the department', async () => {
      const response = await request('GET', `${base()}/${billingId}/eligible-members`, {
        token: adminToken,
      });

      expect(response.statusCode).toBe(200);
      const ids = (response.json() as EligibleMemberList).members.map((member) => member.userId);
      expect(ids).toContain(seeded.userId);
      expect(ids).toContain(leaderId);
      expect(ids).not.toContain(technicalAgentId);
    });

    it('clears a department’s default team when that team is deleted', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';

      const defaulted = await request('PATCH', `${base()}/${billingId}`, {
        token: adminToken,
        body: { defaultTeamId: teamId },
      });
      expect((defaulted.json() as { defaultTeamId: string | null }).defaultTeamId).toBe(teamId);

      await request('DELETE', `${base()}/${billingId}/teams/${teamId}`, { token: adminToken });

      const [billing] = (await listDepartments()).departments;
      expect(billing?.defaultTeamId).toBeNull();
    });

    it('refuses a default team that belongs to another department', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';

      const response = await request('PATCH', `${base()}/${technicalId}`, {
        token: adminToken,
        body: { defaultTeamId: teamId },
      });

      expect(response.statusCode).toBe(404);
    });

    it('lets a Team Leader run the teams of their own department and no other', async () => {
      const mine = await request('POST', `${base()}/${billingId}/teams`, {
        token: leaderToken,
        body: { name: 'Tier 2' },
      });
      const theirs = await request('POST', `${base()}/${technicalId}/teams`, {
        token: leaderToken,
        body: { name: 'Tier 2' },
      });

      expect(mine.statusCode).toBe(201);
      expect(theirs.statusCode).toBe(403);
    });

    it('removes a member and leaves the team behind', async () => {
      const created = await request('POST', `${base()}/${billingId}/teams`, {
        token: adminToken,
        body: { name: 'Front line' },
      });
      const teamId = (created.json() as TeamList).teams[0]?.id ?? '';
      await request('POST', `${base()}/${billingId}/teams/${teamId}/members`, {
        token: adminToken,
        body: { userId: seeded.userId },
      });

      const removed = await request(
        'DELETE',
        `${base()}/${billingId}/teams/${teamId}/members/${seeded.userId}`,
        { token: adminToken },
      );

      expect(removed.statusCode).toBe(200);
      expect((removed.json() as TeamList).teams[0]?.members).toEqual([]);
      expect(await teamsOf(billingId)).toMatchObject({ teams: [{ name: 'Front line' }] });
    });
  });

  describe('cross-brand isolation', () => {
    let otherBrandId: string;

    beforeEach(async () => {
      const [row] = await runtime.db
        .insert(brands)
        .values({ name: `Other ${freshPrefix()}`, prefix: freshPrefix() })
        .returning({ id: brands.id });
      otherBrandId = row?.id ?? '';

      await withSystem(runtime.db, otherBrandId, async (tx) => {
        await tx.insert(departments).values({ brandId: otherBrandId, name: 'Theirs' });
      });
    });

    it('refuses an admin of one brand the departments of another', async () => {
      const response = await request('GET', base(otherBrandId), { token: adminToken });

      expect(response.statusCode).toBe(403);
    });

    it('answers 404 rather than acting on a department of another brand', async () => {
      const theirs = await withSystem(runtime.db, otherBrandId, async (tx) => {
        const rows = await tx.select({ id: departments.id }).from(departments);
        return rows[0]?.id ?? '';
      });

      const response = await request('PATCH', `${base()}/${theirs}`, {
        token: adminToken,
        body: { name: 'Mine now' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('the brand itself', () => {
    it('edits the name, the locale, the time zone and the ticketing settings', async () => {
      const response = await request('PATCH', `/api/brands/${seeded.brandId}`, {
        token: adminToken,
        body: {
          name: 'Helpdock Renamed',
          timezone: 'Europe/London',
          settings: { autoAwaitOnAgentReply: false, reopenPolicy: { kind: 'never' } },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        name: 'Helpdock Renamed',
        timezone: 'Europe/London',
        settings: { autoAwaitOnAgentReply: false, reopenPolicy: { kind: 'never' } },
      });
      expect(await auditActions(seeded.brandId)).toContain('brand.updated');
    });

    it('serves the defaults for a brand whose settings column was never written', async () => {
      const response = await request('GET', `/api/brands/${seeded.brandId}`, { token: adminToken });

      expect((response.json() as Brand).settings).toMatchObject({
        autoAwaitOnAgentReply: expect.any(Boolean),
        reopenPolicy: expect.any(Object),
      });
    });

    it('refuses a time zone that is not an IANA name', async () => {
      const response = await request('PATCH', `/api/brands/${seeded.brandId}`, {
        token: adminToken,
        body: { timezone: 'Mars/Olympus' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('never lets the prefix be edited, because a ticket number is forever', async () => {
      const before = (
        (
          await request('GET', `/api/brands/${seeded.brandId}`, {
            token: adminToken,
          })
        ).json() as Brand
      ).prefix;

      await request('PATCH', `/api/brands/${seeded.brandId}`, {
        token: adminToken,
        body: { name: 'Still here', prefix: 'NOPE' },
      });

      const after = (
        (
          await request('GET', `/api/brands/${seeded.brandId}`, {
            token: adminToken,
          })
        ).json() as Brand
      ).prefix;

      expect(after).toBe(before);
    });

    it('refuses a Team Leader the brand’s own fields', async () => {
      const response = await request('PATCH', `/api/brands/${seeded.brandId}`, {
        token: leaderToken,
        body: { name: 'Mine' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('an additional brand', () => {
    it('gives the creator an admin role, a department and a working ticket sequence', async () => {
      const prefix = freshPrefix();
      const response = await request('POST', '/api/install/brands', {
        token: adminToken,
        body: {
          name: 'New Brand',
          prefix,
          defaultLocale: 'ar',
          timezone: 'Asia/Riyadh',
          firstDepartmentName: 'Front desk',
        },
      });

      expect(response.statusCode).toBe(201);
      const created = response.json() as Brand;
      expect(created).toMatchObject({ prefix, defaultLocale: 'ar', status: 'active' });
      expect(created.settings.reopenPolicy).toEqual({ kind: 'within_days', days: 7 });

      // Read inside the new brand's own context: `user_brand_roles` is a tenant
      // table, so a read without one sees nothing at all — which is the point.
      const role = await withSystem(runtime.db, created.id, (tx) =>
        tx
          .select({ role: userBrandRoles.role, userId: userBrandRoles.userId })
          .from(userBrandRoles),
      );
      expect(role).toEqual([{ role: 'admin', userId: seeded.userId }]);

      // The token in hand was minted before this brand existed, so it does not
      // carry a role in it — DOMAIN-RULES §1.6's "at most ten minutes" lag,
      // visible. A fresh sign-in carries the new claims.
      expect((await request('GET', base(created.id), { token: adminToken })).statusCode).toBe(403);

      const refreshed = await signIn(seeded.email, seeded.password, seeded.totpSecret ?? '');
      const firstDepartments = await request('GET', base(created.id), { token: refreshed });
      expect(
        (firstDepartments.json() as DepartmentSummaryList).departments.map((row) => row.name),
      ).toEqual(['Front desk']);

      const [next] = await ownerDb.db.execute<{ value: string }>(
        sql`SELECT nextval(${brandTicketSequenceName(created.id)})::text AS value`,
      );
      expect(Number(next?.value)).toBeGreaterThan(0);

      const audited = await withSystem(runtime.db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
        const rows = await tx
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.targetId, created.id));

        return rows.map((row) => row.action);
      });
      expect(audited).toContain('brand.created');

      // And inside the brand itself, because an install-scope row is
      // unreachable to the brand admin this call just made.
      expect(await auditActions(created.id, created.id)).toEqual(['brand.created']);
    });

    it('refuses a prefix another brand already has, as a rejected field', async () => {
      const response = await request('POST', '/api/install/brands', {
        token: adminToken,
        body: {
          name: 'Clash',
          prefix: 'HD',
          defaultLocale: 'en',
          timezone: 'UTC',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'validation_failed', fields: [{ path: 'prefix' }] },
      });
    });

    it('is refused to anybody who is not an install administrator', async () => {
      const response = await request('POST', '/api/install/brands', {
        token: leaderToken,
        body: { name: 'Nope', prefix: 'NOPE1', defaultLocale: 'en', timezone: 'UTC' },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
