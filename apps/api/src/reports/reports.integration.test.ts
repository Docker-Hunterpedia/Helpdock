import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Env } from '@helpdock/config';
import {
  brands,
  csatResponses,
  type Db,
  departments,
  hcArticles,
  hcArticleViews,
  hcCategories,
  hcSearchLog,
  hcSections,
  reportDaily,
  seedBrandStatuses,
  ticketMessages,
  ticketSlaClocks,
  ticketStatuses,
  tickets,
  users,
  uuidv7,
  widgetVisitors,
  withSystem,
} from '@helpdock/db';
import type { Principal, ProductMetrics, ReportSummary } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { runBrandRollup } from './rollup.job.js';

/**
 * M8-04's exit criterion: "Reports match seeded data in an integration test."
 *
 * Tickets, replies, SLA clocks, CSAT ratings, help center searches and
 * article views are seeded with known times over three days; `stats.rollup`
 * runs against a real Postgres; and every number the report serves is the
 * one worked out by hand below. Around that: spam, merged and deleted tickets
 * count nowhere, a Team Leader sees only their departments, brand B's tickets
 * never reach brand A's report, "count reopens" changes what it should, a
 * second rollup changes nothing, and the CSV export is safe to open.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const DAY_MS = 86_400_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the reports integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const SUPPORT = uuidv7();
const BILLING = uuidv7();
const OTHER_DEPARTMENT = uuidv7();
const ADMIN = uuidv7();
const AGENT_ONE = uuidv7();
const VISITOR = uuidv7();
const ARTICLE = uuidv7();

/** Three days that end the day before yesterday, all in UTC, the brand's zone. */
const BASE = Math.floor((Date.now() - 5 * DAY_MS) / DAY_MS) * DAY_MS;
const DAY = [0, 1, 2].map((offset) => new Date(BASE + offset * DAY_MS).toISOString().slice(0, 10));
const at = (day: 0 | 1 | 2, time: string): Date => new Date(`${DAY[day]}T${time}:00.000Z`);
const isoWeekday = (day: 0 | 1 | 2): number => ((at(day, '00:00').getUTCDay() + 6) % 7) + 1;
const FROM = DAY[0] ?? '';
const TO = DAY[2] ?? '';

const principal = (
  role: 'admin' | 'team_leader' | 'viewer' | 'agent',
  departmentIds: string[] | 'all' = 'all',
): Principal => ({
  type: 'staff',
  id: ADMIN,
  brands: { [BRAND_A]: { role, departmentIds } },
  installAdmin: true,
});

describe.skipIf(!hasDocker)('reports', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let number = 0;

  const db = (): Db => runtime.db;

  const get = (url: string, as: Principal = principal('admin')) =>
    app.inject({ method: 'GET', url, headers: { [DEV_PRINCIPAL_HEADER]: JSON.stringify(as) } });

  const report = async (query = '', as?: Principal): Promise<ReportSummary> => {
    const response = await get(`/api/brands/${BRAND_A}/reports?from=${FROM}&to=${TO}${query}`, as);
    expect(response.statusCode).toBe(200);
    return response.json<ReportSummary>();
  };

  const rollUp = (brandId: string) =>
    runBrandRollup({ db: db(), brandId, jobId: 'stats.rollup.test', now: new Date() });

  const statusIds = async (brandId: string): Promise<Record<string, string>> =>
    withSystem(db(), brandId, async (tx) => {
      const rows = await tx
        .select({ id: ticketStatuses.id, name: ticketStatuses.name })
        .from(ticketStatuses);
      return Object.fromEntries(rows.map((row) => [row.name, row.id]));
    });

  interface TicketSeed {
    readonly brandId?: string;
    readonly departmentId: string;
    readonly channel: 'email' | 'chat' | 'form' | 'api' | 'manual';
    readonly priority: 'low' | 'medium' | 'high' | 'urgent';
    readonly status: 'Open' | 'Closed' | 'Spam';
    readonly createdAt: Date;
    readonly closedAt?: Date;
    readonly assigneeId?: string;
    readonly deletedAt?: Date;
    readonly mergedIntoId?: string;
    readonly visitorId?: string;
  }

  const seedTicket = async (seed: TicketSeed): Promise<string> => {
    const brandId = seed.brandId ?? BRAND_A;
    const id = uuidv7();
    number += 1;
    const statuses = await statusIds(brandId);
    await withSystem(db(), brandId, (tx) =>
      tx.insert(tickets).values({
        id,
        brandId,
        departmentId: seed.departmentId,
        number,
        prefix: 'RP',
        subject: `Ticket ${number}`,
        statusId: statuses[seed.status] ?? '',
        priority: seed.priority,
        channel: seed.channel,
        createdAt: seed.createdAt,
        closedAt: seed.closedAt ?? null,
        assigneeId: seed.assigneeId ?? null,
        deletedAt: seed.deletedAt ?? null,
        mergedIntoId: seed.mergedIntoId ?? null,
        visitorId: seed.visitorId ?? null,
      }),
    );
    return id;
  };

  const reply = (ticketId: string, authorId: string, createdAt: Date) =>
    withSystem(db(), BRAND_A, (tx) =>
      tx.insert(ticketMessages).values({
        brandId: BRAND_A,
        ticketId,
        departmentId: SUPPORT,
        seq: 1,
        kind: 'public',
        authorType: 'staff',
        authorId,
        bodyHtml: '<p>On it.</p>',
        bodyText: 'On it.',
        channel: 'email',
        createdAt,
      }),
    );

  const rate = (ticketId: string, departmentId: string, rating: number, ratedAt: Date) =>
    withSystem(db(), BRAND_A, (tx) =>
      tx.insert(csatResponses).values({
        brandId: BRAND_A,
        ticketId,
        departmentId,
        closedAt: ratedAt,
        tokenHash: `token-${ticketId}`,
        expiresAt: new Date(ratedAt.getTime() + DAY_MS),
        rating,
        ratedAt,
      }),
    );

  const clock = (
    ticketId: string,
    values: {
      kind: 'first_response' | 'next_response' | 'resolution';
      cycle: number;
      startedAt: Date;
      satisfiedAt?: Date;
      breachedAt?: Date;
      pausedTotalMs?: number;
    },
  ) =>
    withSystem(db(), BRAND_A, (tx) =>
      tx.insert(ticketSlaClocks).values({
        brandId: BRAND_A,
        ticketId,
        departmentId: SUPPORT,
        kind: values.kind,
        cycle: values.cycle,
        isCurrent: true,
        targetMinutes: 60,
        timeMode: 'calendar',
        startedAt: values.startedAt,
        checkpointAt: values.startedAt,
        satisfiedAt: values.satisfiedAt ?? null,
        breachedAt: values.breachedAt ?? null,
        pausedTotalMs: values.pausedTotalMs ?? 0,
      }),
    );

  const seed = async (): Promise<void> => {
    await db()
      .insert(brands)
      .values([
        { id: BRAND_A, name: 'Acme', prefix: 'ACME', timezone: 'UTC' },
        { id: BRAND_B, name: 'Globex', prefix: 'GLOBEX', timezone: 'UTC' },
      ]);
    await db()
      .insert(users)
      .values([
        {
          id: ADMIN,
          email: 'admin@acme.example',
          name: 'Ada Admin',
          status: 'active',
          installAdmin: true,
        },
        { id: AGENT_ONE, email: 'one@acme.example', name: 'Omar One', status: 'active' },
      ]);
    await withSystem(db(), BRAND_A, async (tx) => {
      await seedBrandStatuses(tx, BRAND_A);
      await tx.insert(departments).values([
        { id: SUPPORT, brandId: BRAND_A, name: 'Support' },
        // A name a spreadsheet would run as a formula, for the export.
        { id: BILLING, brandId: BRAND_A, name: '=SUM(1+1)' },
      ]);
      await tx
        .insert(widgetVisitors)
        .values({ id: VISITOR, brandId: BRAND_A, secretHash: 'visitor' });
      const category = uuidv7();
      const section = uuidv7();
      await tx.insert(hcCategories).values({
        id: category,
        brandId: BRAND_A,
        slug: 'returns',
        names: { en: 'Returns', ar: '' },
      });
      await tx.insert(hcSections).values({
        id: section,
        brandId: BRAND_A,
        categoryId: category,
        slug: 'refunds',
        names: { en: 'Refunds', ar: '' },
      });
      await tx
        .insert(hcArticles)
        .values({ id: ARTICLE, brandId: BRAND_A, sectionId: section, slug: 'refund-timelines' });
    });
    await withSystem(db(), BRAND_B, async (tx) => {
      await seedBrandStatuses(tx, BRAND_B);
      await tx
        .insert(departments)
        .values({ id: OTHER_DEPARTMENT, brandId: BRAND_B, name: 'Support' });
    });

    // T1: email, answered by agent one after 30 minutes, closed a day later, rated 5.
    const t1 = await seedTicket({
      departmentId: SUPPORT,
      channel: 'email',
      priority: 'high',
      status: 'Closed',
      createdAt: at(0, '09:15'),
      closedAt: at(1, '09:15'),
      assigneeId: AGENT_ONE,
    });
    await reply(t1, AGENT_ONE, at(0, '09:45'));
    await rate(t1, SUPPORT, 5, at(1, '12:00'));

    // T2: chat, under SLA clocks — answered in an hour with ten minutes paused
    // waiting on the customer, resolution breached a day later, then reopened
    // and answered again on day 2. Still open, with agent one.
    const t2 = await seedTicket({
      departmentId: SUPPORT,
      channel: 'chat',
      priority: 'medium',
      status: 'Open',
      createdAt: at(0, '14:00'),
      assigneeId: AGENT_ONE,
    });
    await reply(t2, AGENT_ONE, at(0, '15:00'));
    await clock(t2, {
      kind: 'first_response',
      cycle: 0,
      startedAt: at(0, '14:00'),
      satisfiedAt: at(0, '15:00'),
      pausedTotalMs: 600_000,
    });
    await clock(t2, {
      kind: 'resolution',
      cycle: 0,
      startedAt: at(0, '14:00'),
      breachedAt: at(1, '14:00'),
    });
    await clock(t2, {
      kind: 'next_response',
      cycle: 1,
      startedAt: at(2, '09:00'),
      satisfiedAt: at(2, '10:00'),
    });

    // T3: email in Billing, filed by the widget visitor half an hour after they read an article.
    const t3 = await seedTicket({
      departmentId: BILLING,
      channel: 'email',
      priority: 'low',
      status: 'Open',
      createdAt: at(1, '08:00'),
      visitorId: VISITOR,
    });

    // Spam, merged and deleted tickets count nowhere.
    await seedTicket({
      departmentId: SUPPORT,
      channel: 'email',
      priority: 'medium',
      status: 'Spam',
      createdAt: at(1, '10:00'),
      closedAt: at(1, '10:05'),
    });
    await seedTicket({
      departmentId: BILLING,
      channel: 'email',
      priority: 'medium',
      status: 'Open',
      createdAt: at(1, '11:00'),
      mergedIntoId: t3,
    });
    await seedTicket({
      departmentId: BILLING,
      channel: 'email',
      priority: 'medium',
      status: 'Open',
      createdAt: at(2, '10:30'),
      deletedAt: at(2, '11:00'),
    });

    // T7: a form ticket in Billing, answered by the admin in two hours, closed after eight, rated 2.
    const t7 = await seedTicket({
      departmentId: BILLING,
      channel: 'form',
      priority: 'urgent',
      status: 'Closed',
      createdAt: at(2, '10:00'),
      closedAt: at(2, '18:00'),
      assigneeId: ADMIN,
    });
    await reply(t7, ADMIN, at(2, '12:00'));
    await rate(t7, BILLING, 2, at(2, '19:00'));

    // Brand B: one API ticket, which must never reach brand A's report.
    await seedTicket({
      brandId: BRAND_B,
      departmentId: OTHER_DEPARTMENT,
      channel: 'api',
      priority: 'high',
      status: 'Open',
      createdAt: at(0, '05:00'),
    });

    await withSystem(db(), BRAND_A, async (tx) => {
      const search = (query: string, hits: number, opened: boolean) => ({
        brandId: BRAND_A,
        query,
        locale: 'en' as const,
        source: 'help_center' as const,
        hits,
        openedAt: opened ? at(1, '07:01') : null,
        createdAt: at(1, '07:00'),
      });
      await tx
        .insert(hcSearchLog)
        .values([
          search('refund', 2, true),
          search('refund', 2, false),
          search('refund', 2, false),
          search('warranty', 0, false),
          search('warranty', 0, false),
        ]);
      const viewHash = (key: string) =>
        createHash('sha256').update(`${BRAND_A}:${key}`).digest('hex');
      await tx.insert(hcArticleViews).values([
        {
          brandId: BRAND_A,
          articleId: ARTICLE,
          visitorHash: viewHash(`widget:${VISITOR}`),
          day: DAY[1] ?? '',
          locale: 'en',
          createdAt: at(1, '07:30'),
        },
        {
          brandId: BRAND_A,
          articleId: ARTICLE,
          visitorHash: viewHash('cookie-visitor'),
          day: DAY[1] ?? '',
          locale: 'en',
          createdAt: at(1, '09:00'),
        },
      ]);
    });

    await rollUp(BRAND_A);
    await rollUp(BRAND_B);
  };

  beforeAll(async () => {
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    const env = {
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      DATABASE_MIGRATION_URL: postgres.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      S3_ENDPOINT: 'http://bucket.test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'unused',
      S3_SECRET_ACCESS_KEY: 'unused',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: [],
    } as Env;
    runtime = await createRuntime({
      env,
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
      }),
    });
    app = await createApiApp({ runtime });
    await seed();
  }, 400_000);

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  describe('the summary matches the seeded tickets', () => {
    it('counts volume by day, channel, priority and status, leaving spam, merged and deleted out', async () => {
      const { volume } = await report();

      expect(volume.created).toBe(4);
      expect(volume.resolved).toBe(2);
      expect(volume.byDay).toEqual([
        { day: DAY[0], created: 2, resolved: 0 },
        { day: DAY[1], created: 1, resolved: 1 },
        { day: DAY[2], created: 1, resolved: 1 },
      ]);
      expect(volume.byChannel).toEqual([
        { channel: 'email', created: 2, resolved: 1 },
        { channel: 'chat', created: 1, resolved: 0 },
        { channel: 'form', created: 1, resolved: 1 },
      ]);
      expect(volume.byPriority).toEqual(
        expect.arrayContaining([
          { priority: 'high', created: 1, resolved: 1 },
          { priority: 'medium', created: 1, resolved: 0 },
          { priority: 'low', created: 1, resolved: 0 },
          { priority: 'urgent', created: 1, resolved: 1 },
        ]),
      );
      expect(volume.byStatus.map(({ name, tickets: n }) => [name, n])).toEqual([
        ['Open', 2],
        ['Closed', 2],
      ]);
    });

    it('takes first-response and resolution percentiles over every sample, less paused time', async () => {
      const summary = await report();

      // 30 min (T1, no clock), 50 min (T2's clock: an hour less ten minutes paused), 2 h (T7).
      expect(summary.firstResponse).toEqual({ count: 3, medianMs: 3_000_000, p90Ms: 6_360_000 });
      // 24 h (T1) and 8 h (T7); T2's resolution clock breached and never satisfied.
      expect(summary.resolution).toEqual({ count: 2, medianMs: 57_600_000, p90Ms: 80_640_000 });
    });

    it('reports SLA compliance from the initial clocks', async () => {
      const { sla } = await report();

      expect(sla).toEqual({
        response: { met: 1, breached: 0, compliance: 1 },
        resolution: { met: 0, breached: 1, compliance: 0 },
        countsReopens: false,
      });
    });

    it('draws the backlog as the tickets open at the end of each day', async () => {
      expect((await report()).backlog).toEqual([
        { day: DAY[0], open: 2 },
        { day: DAY[1], open: 2 },
        { day: DAY[2], open: 2 },
      ]);
    });

    it('summarises CSAT', async () => {
      const { csat } = await report();

      expect(csat).toMatchObject({ responses: 2, average: 3.5, satisfied: 0.5 });
      expect(csat.distribution.map((row) => row.responses)).toEqual([0, 1, 0, 0, 1]);
    });

    it("counts each agent's replies, resolutions and open tickets at the end of the range", async () => {
      expect((await report()).agents).toEqual([
        { agentId: AGENT_ONE, name: 'Omar One', replies: 2, resolved: 1, assignedOpen: 1 },
        { agentId: ADMIN, name: 'Ada Admin', replies: 1, resolved: 1, assignedOpen: 0 },
      ]);
    });

    it('puts every created ticket in its weekday and hour', async () => {
      expect((await report()).busiestHours).toEqual(
        [
          { weekday: isoWeekday(0), hour: 9, created: 1 },
          { weekday: isoWeekday(0), hour: 14, created: 1 },
          { weekday: isoWeekday(1), hour: 8, created: 1 },
          { weekday: isoWeekday(2), hour: 10, created: 1 },
        ].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
      );
    });

    it('lists the top and the zero-result searches', async () => {
      expect((await report()).searches).toEqual({
        top: [
          { query: 'refund', locale: 'en', searches: 3, openedRate: 1 / 3 },
          { query: 'warranty', locale: 'en', searches: 2, openedRate: 0 },
        ],
        zeroResult: [{ query: 'warranty', locale: 'en', searches: 2 }],
      });
    });

    it('says AI is not available until the AI subsystem records calls', async () => {
      expect((await report()).ai).toEqual({ available: false });
    });

    it('never shows another brand’s tickets', async () => {
      const { volume } = await report();

      expect(volume.byChannel.map((row) => row.channel)).not.toContain('api');
    });
  });

  describe('filters and department scope', () => {
    it('narrows to a department and to a channel', async () => {
      expect((await report(`&departmentId=${BILLING}`)).volume.created).toBe(2);
      expect((await report('&channel=email')).volume.created).toBe(2);
      expect((await report(`&departmentId=${BILLING}&channel=form`)).volume.created).toBe(1);
    });

    it("gives a Team Leader their departments' numbers, and zeroes for another's", async () => {
      const lead = principal('team_leader', [SUPPORT]);

      expect((await report('', lead)).volume.created).toBe(2);
      expect((await report('', lead)).agents.map((agent) => agent.agentId)).toEqual([AGENT_ONE]);
      expect((await report(`&departmentId=${BILLING}`, lead)).volume.created).toBe(0);
    });

    it('serves a Viewer and refuses an Agent', async () => {
      await report('', principal('viewer'));
      const refused = await get(
        `/api/brands/${BRAND_A}/reports?from=${FROM}&to=${TO}`,
        principal('agent'),
      );
      expect(refused.statusCode).toBe(403);
    });

    it('refuses a range that ends before it starts', async () => {
      const response = await get(`/api/brands/${BRAND_A}/reports?from=${TO}&to=${FROM}`);
      expect(response.statusCode).toBe(400);
    });
  });

  describe('the rollup', () => {
    it('leaves the same rows behind when it runs again', async () => {
      const rows = () =>
        withSystem(db(), BRAND_A, async (tx) => {
          const [row] = await tx.select({ n: count() }).from(reportDaily);
          return row?.n ?? 0;
        });
      const before = await report();
      const counted = await rows();

      await rollUp(BRAND_A);

      expect(await rows()).toBe(counted);
      expect({ ...(await report()), computedAt: null }).toEqual({ ...before, computedAt: null });
    });

    it('counts reopened clocks once the brand chooses to', async () => {
      const [brand] = await db()
        .select({ settings: brands.settings })
        .from(brands)
        .where(eq(brands.id, BRAND_A));
      await db()
        .update(brands)
        .set({ settings: { ...(brand?.settings ?? {}), slaCountReopens: true } })
        .where(eq(brands.id, BRAND_A));
      await rollUp(BRAND_A);

      const summary = await report();
      expect(summary.firstResponse.count).toBe(4);
      expect(summary.sla.response).toEqual({ met: 2, breached: 0, compliance: 1 });
      expect(summary.sla.countsReopens).toBe(true);

      await db()
        .update(brands)
        .set({ settings: brand?.settings ?? {} })
        .where(eq(brands.id, BRAND_A));
      await rollUp(BRAND_A);
    });
  });

  describe('CSV export', () => {
    const exportOf = (name: string, as?: Principal) =>
      get(`/api/brands/${BRAND_A}/reports/exports/${name}?from=${FROM}&to=${TO}`, as);

    it('streams a CSV file with a row per slice', async () => {
      const response = await exportOf('volume');

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="helpdock-volume-${FROM}-${TO}.csv"`,
      );
      const lines = response.body.trimEnd().split('\r\n');
      expect(lines[0]).toBe('day,department,channel,priority,created,resolved,backlog');
      expect(lines).toContain(`${DAY[0]},Support,email,high,1,0,1`);
    });

    it('writes a cell that would be a formula as text', async () => {
      const response = await exportOf('volume');

      expect(response.body).toContain(`,'=SUM(1+1),`);
      expect(response.body).not.toContain(',=SUM');
    });

    it('exports every report it names and refuses one it does not', async () => {
      for (const name of [
        'response_times',
        'sla',
        'backlog',
        'csat',
        'agents',
        'busiest_hours',
        'searches',
      ]) {
        expect((await exportOf(name)).statusCode, name).toBe(200);
      }
      expect((await exportOf('everything')).statusCode).toBe(400);
      expect((await exportOf('volume', principal('agent'))).statusCode).toBe(403);
    });
  });

  describe('product metrics (DOMAIN-RULES §15)', () => {
    it('counts widget views followed by a ticket within the hour, and the first channel ticket', async () => {
      const response = await get('/api/install/system/metrics');
      expect(response.statusCode).toBe(200);
      const metrics = response.json<ProductMetrics>();

      expect(metrics.activation.firstChannelTicketAt).toBe(at(0, '05:00').toISOString());
      expect(metrics.brands.find((brand) => brand.brandId === BRAND_A)?.selfService).toEqual({
        articleViews: 2,
        widgetViews: 1,
        followedByTicket: 1,
        rate: 0,
      });
    });
  });
});
