import { writeFile } from 'node:fs/promises';
import { type TenantContext, views, withTenant } from '@helpdock/db';
import {
  type TicketList,
  ticketListQuerySchema,
  ticketViewFiltersSchema,
  VIEW_COUNT_CAP,
} from '@helpdock/schemas';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchMode } from '../../tickets/ticket-query.js';
import { TicketRepository } from '../../tickets/tickets.repository.js';
import { DOMAIN_RULES_14, type PerfDataset, seedPerfDataset } from './dataset.js';
import { type LoadResult, type LoadScenario, type LoadSession, runLoad } from './load.js';
import { hasDocker, envNumber as number, type PerfStack, signIn, startPerfStack } from './stack.js';

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
 * | `PERF_NO_MATCH_P95_MS` | 150 | The zero-match search's own gate (ADR 0011) |
 * | `PERF_REPORT` | — | Also write the results as JSON to this path |
 * | `PERF_SCALE` | 1 | Multiplies the dataset, for a quick smoke run (`0.1`) |
 *
 * It is not part of `pnpm test` or CI: a faithful run takes fifteen minutes and
 * the numbers mean something only on the §14 host.
 */

const LIVE_STATES = ['open', 'on_hold', 'escalated'];
const TOKEN_REFRESH_MS = 4 * 60_000;

const settings = {
  concurrency: number('PERF_CONCURRENCY', 50),
  warmupMs: number('PERF_WARMUP_S', 120) * 1000,
  durationMs: number('PERF_DURATION_S', 600) * 1000,
  thinkMs: number('PERF_THINK_MS', 1000),
  replicas: Math.max(1, number('PERF_REPLICAS', 2)),
  gateMs: number('PERF_P95_MS', 150),
  noMatchGateMs: number('PERF_NO_MATCH_P95_MS', 150),
  scale: number('PERF_SCALE', 1),
};

const scaled = (value: number): number => Math.max(1, Math.round(value * settings.scale));

/** One list request: which session asks, and the query string it sends. */
interface ListCase {
  readonly name: string;
  readonly session: 'admin' | 'agent';
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /**
   * A p95 budget of its own instead of the list's. The search nothing matches
   * has one (ADR 0011): until the token table it read every visible ticket and
   * was measured alone, ungated; now it is an index probe and is gated in the
   * mix like everything else, against a budget that can be tuned apart from
   * the list's exit criterion.
   */
  readonly budgetMs?: number;
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
  let stack: PerfStack;
  let dataset: PerfDataset;

  beforeAll(async () => {
    stack = await startPerfStack({
      replicas: settings.replicas,
      seed: async (app, passwordHash) => {
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
          passwordHash,
          log: (message) => process.stdout.write(`${message}\n`),
        });
      },
    });
  }, 1_800_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it(
    'lists under the p95 gate as an Admin and as a department-restricted Agent',
    async () => {
      const { baseUrls } = stack;
      const [firstUrl] = baseUrls as [string];
      const sessions: Record<'admin' | 'agent', LoadSession & { token: string }> = {
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
          // Nothing matches, and the term is long enough for the fuzzy fallback
          // to run too: before ADR 0011 this read every visible ticket.
          {
            name: 'search: no match',
            session,
            query: { q: 'zebra' },
            budgetMs: settings.noMatchGateMs,
          },
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
      const scenarios: LoadScenario[] = [...cases.map(toScenario), ...reads];
      const budgets = new Map(
        cases.map((listCase) => [toScenario(listCase).name, listCase.budgetMs ?? settings.gateMs]),
      );

      const plans = await explainAll(cases);
      let result: LoadResult;
      try {
        result = await runLoad({ baseUrls, scenarios, ...settings });
      } finally {
        clearInterval(refresh);
      }

      report(result, plans);
      if (process.env.PERF_REPORT !== undefined && process.env.PERF_REPORT !== '') {
        await writeFile(
          process.env.PERF_REPORT,
          JSON.stringify({ settings, result, plans }, null, 2),
        );
      }

      const lists = result.scenarios.filter((scenario) => scenario.name.startsWith('list'));
      expect(result.scenarios.every((scenario) => scenario.errors === 0)).toBe(true);
      expect(
        lists
          .filter((scenario) => scenario.p95 > (budgets.get(scenario.name) ?? settings.gateMs))
          .map((scenario) => `${scenario.session} ${scenario.name}`),
      ).toEqual([]);
    },
    // Warm-up and measured window, plus the time the plans take.
    settings.warmupMs + settings.durationMs + 600_000,
  );

  /**
   * The runtime role's plan for each list case, under that session's tenant
   * context. A search that falls back to its fuzzy half is explained twice,
   * because the api runs both statements (ADR 0011).
   */
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
      const query = parsedQuery(listCase.query);

      await withTenant(stack.app.db, context, async (tx) => {
        const reader = { brandId: dataset.brandId, viewerId: context.principalId };
        const page = await repository.listTickets(tx, reader, query);
        const halves: SearchMode[] = page.search === 'fuzzy' ? ['exact', 'fuzzy'] : ['exact'];
        for (const search of halves) {
          const rows = await tx.execute<{ 'QUERY PLAN': string }>(
            sql`EXPLAIN (ANALYZE, BUFFERS) ${repository.listTicketsStatement(tx, reader, query, search)}`,
          );
          const label = search === 'fuzzy' ? ' · fuzzy fallback' : '';
          plans[`${listCase.session} · ${listCase.name}${label}`] = [...rows]
            .map((row) => row['QUERY PLAN'])
            .join('\n');
        }
      });
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

      const rows = await withTenant(stack.app.db, context, async (tx) => {
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

const report = (result: LoadResult, plans: Record<string, string>): void => {
  const lines = [
    '',
    `Settings: ${JSON.stringify(settings)}`,
    `Throughput: ${result.requestsPerSecond.toFixed(1)} req/s; overall p95 ${result.overall.p95.toFixed(1)} ms`,
    '',
    ...table(result),
    '',
    ...Object.entries(plans).flatMap(([name, plan]) => [`--- ${name}`, plan, '']),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
};
