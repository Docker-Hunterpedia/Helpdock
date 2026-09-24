import { type LatencySummary, summarise } from './stats.js';

/**
 * A closed-loop load generator over real HTTP: `concurrency` sessions, each
 * sending one request, waiting for the whole body, pausing `thinkMs`, and
 * sending the next. Nothing is measured during the warm-up (DOMAIN-RULES §14:
 * "measured over 10 minutes after 2 minutes of warm-up").
 *
 * Plain `fetch`, because the stack table has no load-testing tool and this
 * needs none: the question is the api's latency, and a request is a request.
 */

export interface LoadSession {
  readonly label: string;
  /**
   * Read on every request, and deliberately writable: an access token lives
   * ten minutes (`ACCESS_TOKEN_TTL_SECONDS`), shorter than a §14 run, so the
   * caller swaps in a fresh one the way a browser's refresh would.
   */
  token: string;
}

export interface LoadScenario {
  readonly name: string;
  /** Which session sends it. */
  readonly session: LoadSession;
  /** Path and query, appended to one of the base URLs. */
  readonly path: string;
}

export interface LoadOptions {
  /** One per api replica; sessions are spread over them round-robin. */
  readonly baseUrls: readonly string[];
  readonly scenarios: readonly LoadScenario[];
  readonly concurrency: number;
  readonly warmupMs: number;
  readonly durationMs: number;
  /** Pause between one response and the next request of the same session. */
  readonly thinkMs: number;
}

export interface ScenarioResult extends LatencySummary {
  readonly name: string;
  readonly session: string;
  /** Responses that were not 200. Any at all fails the run. */
  readonly errors: number;
}

export interface LoadResult {
  readonly scenarios: readonly ScenarioResult[];
  /** Every measured request of the run, whatever its scenario. */
  readonly overall: LatencySummary;
  readonly requestsPerSecond: number;
}

const pause = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export const runLoad = async ({
  baseUrls,
  scenarios,
  concurrency,
  warmupMs,
  durationMs,
  thinkMs,
}: LoadOptions): Promise<LoadResult> => {
  const samples = new Map<LoadScenario, number[]>(scenarios.map((scenario) => [scenario, []]));
  const errors = new Map<LoadScenario, number>(scenarios.map((scenario) => [scenario, 0]));

  const started = performance.now();
  const measureFrom = started + warmupMs;
  const stopAt = measureFrom + durationMs;

  const session = async (index: number): Promise<void> => {
    const baseUrl = baseUrls[index % baseUrls.length];
    // Each session starts at a different scenario, so all of them are in
    // flight at once rather than every session asking the same question.
    let next = index % scenarios.length;

    while (performance.now() < stopAt) {
      const scenario = scenarios[next] as LoadScenario;
      next = (next + 1) % scenarios.length;

      const sent = performance.now();
      const response = await fetch(`${baseUrl}${scenario.path}`, {
        headers: { authorization: `Bearer ${scenario.session.token}` },
      });
      await response.arrayBuffer();
      const received = performance.now();

      if (sent >= measureFrom && received <= stopAt) {
        samples.get(scenario)?.push(received - sent);
        if (response.status !== 200) {
          errors.set(scenario, (errors.get(scenario) ?? 0) + 1);
        }
      }

      await pause(thinkMs);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, index) => session(index)));

  const all = [...samples.values()].flat();

  return {
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      session: scenario.session.label,
      errors: errors.get(scenario) ?? 0,
      ...summarise(samples.get(scenario) ?? []),
    })),
    overall: summarise(all),
    requestsPerSecond: all.length / (durationMs / 1000),
  };
};
