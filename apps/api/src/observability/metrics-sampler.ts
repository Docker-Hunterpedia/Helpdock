import type { RelayStatus } from '@helpdock/jobs';
import type { QueueCounts } from '@helpdock/schemas';
import type { Metrics } from './metrics.js';
import { RELAY_STALE_MS } from './system-view.js';
import { MILLIS_PER_SECOND } from './time.js';

/**
 * The gauges nobody pushes: queue depth, the outbox backlog, the pool and the
 * two dependency probes. A gauge has to be read from somewhere, so something
 * has to go and look — every 15 s, which is well under a Prometheus scrape
 * interval and cheap enough to be invisible.
 *
 * The functions here are pure in the way that matters: they take a reading and
 * write it to the registry, so a test asserts on numbers rather than on timing.
 * {@link MetricsSampler} is the loop around them.
 */

export const SAMPLE_INTERVAL_MS = 15_000;

export const recordQueueCounts = (metrics: Metrics, counts: readonly QueueCounts[]): void => {
  for (const queue of counts) {
    metrics.queueJobs.set({ queue: queue.name, state: 'waiting' }, queue.waiting);
    metrics.queueJobs.set({ queue: queue.name, state: 'active' }, queue.active);
    metrics.queueJobs.set({ queue: queue.name, state: 'failed' }, queue.failed);
    metrics.queueJobs.set({ queue: queue.name, state: 'delayed' }, queue.delayed);
    metrics.queueJobs.set({ queue: queue.name, state: 'completed' }, queue.completed);
  }
};

/**
 * The relay's heartbeat, turned into the two outbox metrics.
 *
 * The histogram is observed once per *reported* cycle, which is why the caller
 * passes what it last saw: the relay cycles far more often than this samples,
 * so without the check a slow cycle that happened to be the last one would be
 * counted again every 15 s and skew the distribution towards itself.
 *
 * Returns the timestamp to remember for the next call.
 */
export const recordRelayStatus = (
  metrics: Metrics,
  status: RelayStatus | null,
  lastObservedAt: string | null,
  now: number = Date.now(),
): string | null => {
  // A stale heartbeat is no heartbeat, aged out at exactly the point the System
  // page uses — otherwise an alert and the screen an operator opens after it
  // would disagree about whether the worker is alive. The Redis key's own TTL
  // is five minutes and is only the backstop.
  if (status === null || now - Date.parse(status.at) > RELAY_STALE_MS) {
    // No relay is reporting. Leaving the backlog at its last value would be a
    // lie an alert would act on, and zero on its own would be a different one —
    // it reads as "nothing to publish". `outbox_relay_up` is what tells the two
    // apart, so it is what an alert should be written against.
    metrics.outboxUnpublishedRows.set(0);
    metrics.outboxRelayUp.set(0);
    return lastObservedAt;
  }

  metrics.outboxUnpublishedRows.set(status.pending);
  metrics.outboxRelayUp.set(1);

  if (status.at !== lastObservedAt) {
    metrics.outboxRelayCycleSeconds.observe(status.durationMs / MILLIS_PER_SECOND);
  }

  return status.at;
};

export const recordDependency = (
  metrics: Metrics,
  { database, redis }: { readonly database: boolean; readonly redis: boolean },
): void => {
  metrics.dbUp.set(database ? 1 : 0);
  metrics.redisUp.set(redis ? 1 : 0);
};

export const recordPoolConnections = (
  metrics: Metrics,
  connections: ReadonlyMap<string, number>,
): void => {
  metrics.dbPoolConnections.reset();
  for (const [state, count] of connections) {
    metrics.dbPoolConnections.set({ state }, count);
  }
};

export interface SamplerLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface MetricsSamplerOptions {
  readonly sample: () => Promise<void>;
  readonly log: SamplerLogger;
  readonly intervalMs?: number;
}

/**
 * Runs `sample` on a timer. The timer is `unref`'d so it can never be the
 * reason a process refuses to exit, and a sample that throws is logged and
 * dropped: a metrics reading is not worth taking a replica down for.
 */
export class MetricsSampler {
  readonly #options: Required<MetricsSamplerOptions>;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: MetricsSamplerOptions) {
    this.#options = { intervalMs: SAMPLE_INTERVAL_MS, ...options };
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sampleOnce();
    }, this.#options.intervalMs);
    this.#timer.unref();
  }

  async sampleOnce(): Promise<void> {
    try {
      await this.#options.sample();
    } catch (error) {
      this.#options.log.warn({ err: error }, 'Could not sample the observability gauges');
    }
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
