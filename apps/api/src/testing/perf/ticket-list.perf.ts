import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeMasterKey } from '@helpdock/config';
import {
  createDb,
  type DbHandle,
  runMigrations,
  type TenantContext,
  views,
  withTenant,
} from '@helpdock/db';
import {
  type TicketList,
  ticketListQuerySchema,
  ticketViewFiltersSchema,
  VIEW_COUNT_CAP,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../../auth/password.js';
import { TicketRepository } from '../../tickets/tickets.repository.js';
import { DOMAIN_RULES_14, type PerfDataset, seedPerfDataset } from './dataset.js';
import { type LoadResult, type LoadScenario, type LoadSession, runLoad } from './load.js';

/**
 * The M1 exit criterion: "Ticket list of 50k seeded tickets loads under 150 ms
 * p95 under the D §14 conditions."
 *
 *   pnpm --filter @helpdock/api build
 *   pnpm --filter @helpdock/api perf:tickets
 *
 * It seeds the §14 dataset into a fresh Postgres, starts **two api replicas**
 * from `dist/` as separate processes (§14: "2 `api` replicas"), signs in as an
 * Admin and as an Agent confined to two departments, and drives the list —
 * every default view, a search, a tag filter, the second page — the ticket
 * read and the sidebar's view counts (M1-05) through the real HTTP stack, the guards and the tenant transaction.
 * Then it `EXPLAIN (ANALYZE, BUFFERS)`s each list query as the runtime role, so
 * the plans the report prints are the ones row-level security actually shapes.
 *
 * Environment (all optional):
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `PERF_CONCURRENCY` | 50 | Concurrent staff sessions (§14) |
 * | `PERF_WARMUP_S` | 120 | Warm-up, not measured (§14) |
 * | `PERF_DURATION_S` | 600 | Measured window (§14) |
 * | `PERF_THINK_MS` | 1000 | Pause between a session's requests |
 * | `PERF_REPLICAS` | 2 | Api processes |
 * | `PERF_P95_MS` | 150 | The gate |
 * | `PERF_REPORT` | — | Also write the results as JSON to this path |
 * | `PERF_SCALE` | 1 | Multiplies the dataset, for a quick smoke run (`0.1`) |
 *
 * It is not part of `pnpm test` or CI: a faithful run takes fifteen minutes and
 * the numbers mean something only on the §14 host.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'perf-app-role-password';
const MASTER_KEY = Buffer.alloc(32, 14).toString('base64');
const PASSWORD = 'a perf run password';
const API_ROOT = path.resolve(import.meta.dirname, '../../..');
const API_ENTRY = path.join(API_ROOT, 'dist/main.js');
const BASE_PORT = 3900;
const LIVE_STATES = ['open', 'on_hold', 'escalated'];
const TOKEN_REFRESH_MS = 4 * 60_000;

const number = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
};

const settings = {
  concurrency: number('PERF_CONCURRENCY', 50),
  warmupMs: number('PERF_WARMUP_S', 120) * 1000,
  durationMs: number('PERF_DURATION_S', 600) * 1000,
  thinkMs: number('PERF_THINK_MS', 1000),
  replicas: Math.max(1, number('PERF_REPLICAS', 2)),
  gateMs: number('PERF_P95_MS', 150),
  scale: number('PERF_SCALE', 1),
};

const scaled = (value: number): number => Math.max(1, Math.round(value * settings.scale));

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

/** One list request: which session asks, and the query string it sends. */
interface ListCase {
  readonly name: string;
  readonly session: 'admin' | 'agent';
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /**
   * `false` for the known worst case (a search nothing matches), which is
   * measured alone after the load and reported, not gated: its cost is the
   * limit docs/guides/tickets.md "Performance" describes, and inside the mix
   * it would be measuring that limit through every other scenario's tail.
   */
  readonly gated?: false;
}

const queryString = (query: ListCase['query']): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of typeof value === 'string' ? [value] : value) {
      params.append(key, item);
    }
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
};

/** What the query string parses to on the server, for `EXPLAIN`. */
const parsedQuery = (query: ListCase['query']) =>
  ticketListQuerySchema.parse(
    Object.fromEntries(
      Object.entries(query).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : [...value],
      ]),
    ),
  );

describe.skipIf(!hasDocker)('ticket list at 50k tickets (M1-15, DOMAIN-RULES §14)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let owner: DbHandle;
  let app: DbHandle;
  let dataset: PerfDataset;
  const replicas: ChildProcess[] = [];
  const baseUrls: string[] = [];

  beforeAll(async () => {
    if (!existsSync(API_ENTRY)) {
      throw new Error(`${API_ENTRY} is missing: run \`pnpm --filter @helpdock/api build\` first`);
    }

    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(120_000).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(120_000).start(),
    ]);

    const bootstrap = createDb({ url: postgres.getConnectionUri(), max: 1 });
    await bootstrap.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await bootstrap.close();

    const hostPort = `${postgres.getHost()}:${postgres.getPort()}`;
    const migrationUrl = `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${hostPort}/helpdock`;
    const appUrl = `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${hostPort}/helpdock`;

    await runMigrations({ migrationUrl, appRolePassword: APP_ROLE_PASSWORD, log: () => {} });
    owner = createDb({ url: migrationUrl, max: 2 });
    app = createDb({ url: appUrl, max: 2 });

    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the perf master key is not 32 bytes of base64');
    }

    const seedStarted = performance.now();
    // Seeded as the runtime role, so every row passes the same policies and
    // triggers the api's writes do; analysed as the owner, which the runtime
    // role deliberately is not.
    dataset = await seedPerfDataset(app.db, {
      measured: {
        ...DOMAIN_RULES_14.measured,
        tickets: scaled(DOMAIN_RULES_14.measured.tickets),
        contacts: scaled(DOMAIN_RULES_14.measured.contacts),
      },
      others: {
        ...DOMAIN_RULES_14.others,
        tickets: scaled(DOMAIN_RULES_14.others.tickets),
        contacts: scaled(DOMAIN_RULES_14.others.contacts),
      },
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
      log: (message) => process.stdout.write(`${message}\n`),
    });
    await owner.db.execute(sql`ANALYZE`);
    process.stdout.write(`Seeded in ${Math.round((performance.now() - seedStarted) / 1000)} s.\n`);

    for (let index = 0; index < settings.replicas; index += 1) {
      const port = BASE_PORT + index;
      replicas.push(
        spawn(process.execPath, [API_ENTRY], {
          cwd: API_ROOT,
          stdio: ['ignore', 'ignore', 'inherit'],
          env: {
            ...process.env,
            APP_URL: `http://127.0.0.1:${port}`,
            APP_ROLE: 'api',
            APP_MASTER_KEY: MASTER_KEY,
            NODE_ENV: 'production',
            LOG_LEVEL: 'warn',
            PORT: String(port),
            DATABASE_URL: appUrl,
            DATABASE_MIGRATION_URL: migrationUrl,
            REDIS_URL: redis.getConnectionUrl(),
            S3_ENDPOINT: 'http://127.0.0.1:9',
            S3_REGION: 'us-east-1',
            S3_BUCKET: 'helpdock',
            S3_ACCESS_KEY_ID: 'perf',
            S3_SECRET_ACCESS_KEY: 'perf',
          },
        }),
      );
      baseUrls.push(`http://127.0.0.1:${port}`);
    }

    for (const baseUrl of baseUrls) {
      await waitForHealth(baseUrl);
    }
  }, 1_800_000);

  afterAll(async () => {
    for (const replica of replicas) {
      replica.kill('SIGTERM');
    }
    await app?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it(
    'lists under the p95 gate as an Admin and as a department-restricted Agent',
    async () => {
      const [firstUrl] = baseUrls as [string];
      const sessions: Record<'admin' | 'agent', LoadSession> = {
        admin: { label: 'admin', token: await signIn(firstUrl, dataset.admin.email) },
        agent: { label: 'agent', token: await signIn(firstUrl, dataset.agent.email) },
      };
      // Well inside the ten-minute access token, so no request of the run is
      // sent with one that has expired.
      const refresh = setInterval(() => {
        void (async () => {
          sessions.admin.token = await signIn(firstUrl, dataset.admin.email);
          sessions.agent.token = await signIn(firstUrl, dataset.agent.email);
        })();
      }, TOKEN_REFRESH_MS);
      const listPath = `/api/brands/${dataset.brandId}/tickets`;

      const cases: ListCase[] = [];
      const reads: LoadScenario[] = [];
      for (const session of ['admin', 'agent'] as const) {
        const viewer = session === 'admin' ? dataset.admin.id : dataset.agent.id;
        const firstPage = await getJson<TicketList>(firstUrl, listPath, sessions[session].token);
        reads.push({
          name: 'read · open a ticket',
          session: sessions[session],
          path: `${listPath}/${firstPage.tickets[0]?.id}`,
        });
        // M1-05: every visible view counted, capped, in one request — what the
        // sidebar asks for on every screen that shows it. Gated like a list.
        reads.push({
          name: 'list · view counts (sidebar)',
          session: sessions[session],
          path: `/api/brands/${dataset.brandId}/views/counts`,
        });

        cases.push(
          { name: 'all (default)', session, query: {} },
          {
            name: 'view: my open',
            session,
            query: { assigneeId: viewer, systemState: LIVE_STATES },
          },
          {
            name: 'view: unassigned',
            session,
            query: { assigneeId: 'unassigned', systemState: LIVE_STATES },
          },
          { name: 'view: overdue (live states)', session, query: { systemState: LIVE_STATES } },
          { name: 'view: escalated', session, query: { systemState: 'escalated' } },
          { name: 'search: refund', session, query: { q: 'refund' } },
          { name: 'search: renewa (typo)', session, query: { q: 'renewa' } },
          // The worst case: nothing matches, so every visible ticket is read.
          { name: 'search: no match', session, query: { q: 'zebra' }, gated: false },
          { name: 'tags: all-of two', session, query: { tagIds: [...dataset.tagPair] } },
          {
            name: 'page 2 (keyset)',
            session,
            query: firstPage.nextCursor === null ? {} : { cursor: firstPage.nextCursor },
          },
        );
      }

      const toScenario = (listCase: ListCase): LoadScenario => ({
        name: `list · ${listCase.name}`,
        session: sessions[listCase.session],
        path: `${listPath}${queryString(listCase.query)}`,
      });
      const scenarios: LoadScenario[] = [
        ...cases.filter((listCase) => listCase.gated !== false).map(toScenario),
        ...reads,
      ];

      const plans = await explainAll(cases);
      let result: LoadResult;
      let alone: LoadResult;
      try {
        result = await runLoad({ baseUrls, scenarios, ...settings });
        // One session, nothing else running: what the worst case costs by itself.
        alone = await runLoad({
          baseUrls,
          scenarios: cases.filter((listCase) => listCase.gated === false).map(toScenario),
          concurrency: 1,
          warmupMs: 2_000,
          durationMs: 20_000,
          thinkMs: 0,
        });
      } finally {
        clearInterval(refresh);
      }

      report(result, alone, plans);
      if (process.env.PERF_REPORT !== undefined && process.env.PERF_REPORT !== '') {
        await writeFile(
          process.env.PERF_REPORT,
          JSON.stringify({ settings, result, alone, plans }, null, 2),
        );
      }

      const lists = result.scenarios.filter((scenario) => scenario.name.startsWith('list'));
      expect(result.scenarios.every((scenario) => scenario.errors === 0)).toBe(true);
      expect(
        lists.filter((scenario) => scenario.p95 > settings.gateMs).map((scenario) => scenario.name),
      ).toEqual([]);
    },
    // Warm-up and measured window, plus the time the plans take.
    settings.warmupMs + settings.durationMs + 600_000,
  );

  /** The runtime role's plan for each list case, under that session's tenant context. */
  const explainAll = async (cases: readonly ListCase[]): Promise<Record<string, string>> => {
    const repository = new TicketRepository();
    const plans: Record<string, string> = {};

    for (const listCase of cases) {
      const context: TenantContext = {
        brandIds: [dataset.brandId],
        departmentIds: listCase.session === 'admin' ? 'all' : dataset.agentDepartmentIds,
        principalType: 'staff',
        principalId: listCase.session === 'admin' ? dataset.admin.id : dataset.agent.id,
      };

      const rows = await withTenant(app.db, context, (tx) =>
        tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN (ANALYZE, BUFFERS) ${repository.listTicketsStatement(tx, { brandId: dataset.brandId, viewerId: context.principalId }, parsedQuery(listCase.query))}`,
        ),
      );
      plans[`${listCase.session} · ${listCase.name}`] = [...rows]
        .map((row) => row['QUERY PLAN'])
        .join('\n');
    }

    // M1-05: the sidebar's counts, as the counts route runs them — one
    // statement over every view the session's sidebar shows.
    for (const session of ['admin', 'agent'] as const) {
      const principalId = session === 'admin' ? dataset.admin.id : dataset.agent.id;
      const context: TenantContext = {
        brandIds: [dataset.brandId],
        departmentIds: session === 'admin' ? 'all' : dataset.agentDepartmentIds,
        principalType: 'staff',
        principalId,
      };

      const rows = await withTenant(app.db, context, async (tx) => {
        const shown = (await tx.select().from(views)).filter(
          (view) =>
            view.visibleDepartmentIds === null ||
            context.departmentIds === 'all' ||
            view.visibleDepartmentIds.some((id) => context.departmentIds.includes(id)),
        );

        return tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN (ANALYZE, BUFFERS) ${repository.countTicketsStatement(
            tx,
            { brandId: dataset.brandId, viewerId: principalId },
            shown.map((view) => ticketViewFiltersSchema.parse(view.filters)),
            VIEW_COUNT_CAP,
          )}`,
        );
      });
      plans[`${session} · view counts (sidebar)`] = [...rows]
        .map((row) => row['QUERY PLAN'])
        .join('\n');
    }

    return plans;
  };
});

const waitForHealth = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${baseUrl}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${baseUrl} did not become healthy`);
};

const signIn = async (baseUrl: string, email: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await response.json()) as { kind?: string; accessToken?: string };
  if (body.kind !== 'session' || body.accessToken === undefined) {
    throw new Error(`sign-in as ${email} did not produce a session`);
  }
  return body.accessToken;
};

const getJson = async <T>(baseUrl: string, pathAndQuery: string, token: string): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${pathAndQuery} answered ${response.status}`);
  }
  return (await response.json()) as T;
};

const table = (result: LoadResult): string[] => [
  '| Session | Scenario | Requests | p50 ms | p95 ms | p99 ms | Errors |',
  '|---|---|---|---|---|---|---|',
  ...result.scenarios.map(
    (scenario) =>
      `| ${scenario.session} | ${scenario.name} | ${scenario.count} | ${scenario.p50.toFixed(1)} | ${scenario.p95.toFixed(1)} | ${scenario.p99.toFixed(1)} | ${scenario.errors} |`,
  ),
];

const report = (result: LoadResult, alone: LoadResult, plans: Record<string, string>): void => {
  const lines = [
    '',
    `Settings: ${JSON.stringify(settings)}`,
    `Throughput: ${result.requestsPerSecond.toFixed(1)} req/s; overall p95 ${result.overall.p95.toFixed(1)} ms`,
    '',
    ...table(result),
    '',
    'Measured alone, not gated:',
    '',
    ...table(alone),
    '',
    ...Object.entries(plans).flatMap(([name, plan]) => [`--- ${name}`, plan, '']),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
};
