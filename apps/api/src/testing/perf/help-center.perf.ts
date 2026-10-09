import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_RULES_14, type PerfDataset, scaleDataset, seedPerfDataset } from './dataset.js';
import {
  DOMAIN_RULES_14_HELP_CENTER,
  type SeededHelpCenter,
  seedHelpCenter,
} from './help-center-dataset.js';
import { type LoadResult, type LoadScenario, type LoadSession, runLoad } from './load.js';
import { envNumber, hasDocker, type PerfStack, startPerfStack } from './stack.js';
import { summarise } from './stats.js';

/**
 * The M9-03 help center gate: "Help center SSR TTFB (cached) < 200 ms" (PRD §2),
 * and DOMAIN-RULES §14's "cold render must stay under 800 ms".
 *
 *   pnpm --filter @helpdock/api build
 *   pnpm --filter @helpdock/api perf:help-center
 *
 * It seeds the §14 dataset — the ticket brands, and 2 000 articles in `en` and
 * `ar` in the measured brand — starts the api replicas, and then:
 *
 * 1. **Cold.** One visitor opens article pages nobody has opened yet, one at a
 *    time, so every one is rendered from the database. p95 of the time to the
 *    first byte is gated at `PERF_COLD_P95_MS`.
 * 2. **Cached.** `PERF_CONCURRENCY` visitors browse the home pages, categories,
 *    sections and a set of articles in both languages; the warm-up fills the
 *    Redis page cache, and the measured window is cache hits. p95 TTFB over
 *    every page of a kind (home, category, section, article, per language) is
 *    gated at `PERF_TTFB_P95_MS`.
 *
 * The pages are read at `/hc/<brandId>/…`, the address every brand has; a
 * custom domain is the same page with a different host.
 *
 * Environment (all optional): `PERF_CONCURRENCY` (50), `PERF_WARMUP_S` (120),
 * `PERF_DURATION_S` (600), `PERF_THINK_MS` (1000), `PERF_REPLICAS` (2),
 * `PERF_TTFB_P95_MS` (200), `PERF_COLD_P95_MS` (800), `PERF_COLD_PAGES` (100),
 * `PERF_SCALE` (1, multiplies the ticket dataset), `PERF_REPORT` (a JSON path).
 */

const settings = {
  concurrency: envNumber('PERF_CONCURRENCY', 50),
  warmupMs: envNumber('PERF_WARMUP_S', 120) * 1000,
  durationMs: envNumber('PERF_DURATION_S', 600) * 1000,
  thinkMs: envNumber('PERF_THINK_MS', 1000),
  replicas: Math.max(1, envNumber('PERF_REPLICAS', 2)),
  ttfbGateMs: envNumber('PERF_TTFB_P95_MS', 200),
  coldGateMs: envNumber('PERF_COLD_P95_MS', 800),
  coldPages: Math.max(1, envNumber('PERF_COLD_PAGES', 100)),
  scale: envNumber('PERF_SCALE', 1),
};

/** How many articles per language the cached scenario rotates through. */
const CACHED_ARTICLES = 40;

describe.skipIf(!hasDocker)('help center TTFB (M9-03, DOMAIN-RULES §14)', () => {
  let stack: PerfStack;
  let dataset: PerfDataset;
  let site: SeededHelpCenter;

  beforeAll(async () => {
    stack = await startPerfStack({
      replicas: settings.replicas,
      seed: async (app, passwordHash) => {
        dataset = await seedPerfDataset(app.db, {
          measured: scaleDataset(DOMAIN_RULES_14.measured, settings.scale),
          others: scaleDataset(DOMAIN_RULES_14.others, settings.scale),
          passwordHash,
          log: (message) => process.stdout.write(`${message}\n`),
        });
        site = await seedHelpCenter(app.db, dataset.brandId, DOMAIN_RULES_14_HELP_CENTER);
      },
    });
  }, 1_800_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it(
    'renders cold under its budget and serves cached pages under the TTFB gate',
    async () => {
      const [firstUrl] = stack.baseUrls as [string];
      const base = `/hc/${dataset.brandId}`;

      // Articles from the far end of the list, which the cached scenario below
      // never touches, so each one is a miss.
      const coldPaths = site.articleSlugs
        .slice(-settings.coldPages)
        .map((slug, index) => `${base}/${index % 2 === 0 ? 'en' : 'ar'}/articles/${slug}`);
      const cold = await timeToFirstByte(firstUrl, coldPaths);

      const visitor: LoadSession = { label: 'visitor', token: null };
      const scenario = (name: string, path: string): LoadScenario => ({
        name,
        session: visitor,
        path: `${base}${path}`,
      });
      const scenarios = interleave(
        (['en', 'ar'] as const).flatMap((locale) => [
          [scenario(`home · ${locale}`, `/${locale}`)],
          site.categorySlugs.map((slug) =>
            scenario(`category · ${locale}`, `/${locale}/categories/${slug}`),
          ),
          site.sectionSlugs.map((slug) =>
            scenario(`section · ${locale}`, `/${locale}/sections/${slug}`),
          ),
          site.articleSlugs
            .slice(0, CACHED_ARTICLES)
            .map((slug) => scenario(`article · ${locale}`, `/${locale}/articles/${slug}`)),
        ]),
      );

      // Every page once on every replica, so the measured window holds hits
      // only however short the warm-up; then once more, alone, for the report:
      // the cost of a hit without queueing behind other visitors.
      for (const baseUrl of stack.baseUrls) {
        await timeToFirstByte(
          baseUrl,
          scenarios.map((entry) => entry.path),
        );
      }
      const alone = await timeToFirstByte(
        firstUrl,
        scenarios.map((entry) => entry.path),
      );

      const result = await runLoad({
        baseUrls: stack.baseUrls,
        scenarios,
        ...settings,
        until: 'headers',
      });

      report(cold, alone, result);
      if (process.env.PERF_REPORT !== undefined && process.env.PERF_REPORT !== '') {
        await writeFile(
          process.env.PERF_REPORT,
          JSON.stringify({ settings, cold, alone, result }, null, 2),
        );
      }

      expect(cold.errors).toBe(0);
      expect(cold.summary.p95).toBeLessThanOrEqual(settings.coldGateMs);
      expect(result.scenarios.every((kind) => kind.errors === 0)).toBe(true);
      expect(
        result.scenarios.filter((kind) => kind.p95 > settings.ttfbGateMs).map((kind) => kind.name),
      ).toEqual([]);
    },
    settings.warmupMs + settings.durationMs + 600_000,
  );
});

/** Round-robin across the lists, so a short run still sees every kind of page. */
const interleave = <T>(lists: readonly (readonly T[])[]): T[] => {
  const longest = Math.max(...lists.map((list) => list.length));
  return Array.from({ length: longest }, (_, index) =>
    lists.flatMap((list) => (index < list.length ? [list[index] as T] : [])),
  ).flat();
};

interface ColdResult {
  readonly summary: ReturnType<typeof summarise>;
  readonly errors: number;
}

/** One request at a time, so each is measured alone. */
const timeToFirstByte = async (baseUrl: string, paths: readonly string[]): Promise<ColdResult> => {
  const samples: number[] = [];
  let errors = 0;
  for (const path of paths) {
    const sent = performance.now();
    const response = await fetch(`${baseUrl}${path}`);
    samples.push(performance.now() - sent);
    await response.arrayBuffer();
    if (response.status !== 200) {
      errors += 1;
    }
  }
  return { summary: summarise(samples), errors };
};

const report = (cold: ColdResult, alone: ColdResult, result: LoadResult): void => {
  const lines = [
    '',
    `Settings: ${JSON.stringify(settings)}`,
    `Cold render: ${cold.summary.count} pages, p50 ${cold.summary.p50.toFixed(1)} ms, p95 ${cold.summary.p95.toFixed(1)} ms, errors ${cold.errors}`,
    `Cached, one visitor: p50 ${alone.summary.p50.toFixed(1)} ms, p95 ${alone.summary.p95.toFixed(1)} ms`,
    `Cached: ${result.requestsPerSecond.toFixed(1)} req/s; overall p95 TTFB ${result.overall.p95.toFixed(1)} ms`,
    '',
    '| Page kind | Requests | p50 TTFB ms | p95 TTFB ms | Errors |',
    '|---|---|---|---|---|',
    ...result.scenarios.map(
      (kind) =>
        `| ${kind.name} | ${kind.count} | ${kind.p50.toFixed(1)} | ${kind.p95.toFixed(1)} | ${kind.errors} |`,
    ),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
};
