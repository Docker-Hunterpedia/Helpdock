import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * The Prometheus surface of ARCHITECTURE §14: http latency histograms, queue
 * depth and failures, socket connections, and the two dependencies a replica
 * cannot serve without.
 *
 * Everything hangs off one {@link Registry} that is created rather than taken
 * from `prom-client`'s global default. A global registry is process state: two
 * suites in one Vitest worker would register the same metric name twice and the
 * second would throw, and a test could not assert on a number without the
 * previous test's numbers still being in it. One registry per app instance,
 * handed to whoever needs it, has neither problem.
 *
 * Label rules, because a Prometheus label is a cardinality bill:
 *
 * - `route` is a route *template* (`/api/brands/:brandId`), never a URL. See
 *   `http-metrics.ts`.
 * - `status` is the numeric code as a string, not a message.
 * - Nothing is labelled by brand, user, ticket or request id. A metric is for
 *   the install; the log line carries the request (`ARCHITECTURE §14`).
 */

/**
 * Seconds. Tight at the bottom because a healthy admin read is single-digit
 * milliseconds, and up to 10 s at the top so a pathological request is visible
 * rather than clipped into `+Inf`.
 */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Seconds. A relay cycle is expected in tens of milliseconds; a slow one matters. */
const RELAY_CYCLE_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export type HttpLabel = 'route' | 'method' | 'status';

export interface Metrics {
  readonly registry: Registry;
  readonly httpRequestDuration: Histogram<HttpLabel>;
  readonly httpRequestsTotal: Counter<HttpLabel>;
  /** `state` is BullMQ's: waiting, active, failed, delayed, completed. */
  readonly queueJobs: Gauge<'queue' | 'state'>;
  readonly outboxUnpublishedRows: Gauge<never>;
  readonly outboxRelayUp: Gauge<never>;
  readonly outboxRelayCycleSeconds: Histogram<never>;
  /** `state` as Postgres reports it for this role's sessions. */
  readonly dbPoolConnections: Gauge<'state'>;
  readonly dbUp: Gauge<never>;
  readonly redisUp: Gauge<never>;
  /** `namespace` is the Socket.IO one: `/staff`, and `/widget` from M4. */
  readonly socketConnections: Gauge<'namespace'>;
}

/**
 * A fresh registry with every Helpdock metric and the default Node ones
 * (event loop lag, heap, handles, GC) registered on it.
 */
export const createMetrics = (): Metrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const registers = [registry];

  return {
    registry,
    httpRequestDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Time from request to response, by route template, method and status.',
      labelNames: ['route', 'method', 'status'],
      buckets: HTTP_DURATION_BUCKETS,
      registers,
    }),
    httpRequestsTotal: new Counter({
      name: 'http_requests_total',
      help: 'Responses served, by route template, method and status.',
      labelNames: ['route', 'method', 'status'],
      registers,
    }),
    queueJobs: new Gauge({
      name: 'queue_jobs',
      help: 'Jobs in each BullMQ queue, by state. Sampled, not live.',
      labelNames: ['queue', 'state'],
      registers,
    }),
    outboxUnpublishedRows: new Gauge({
      name: 'outbox_unpublished_rows',
      help: 'Outbox rows waiting to be published, as the relay last counted them.',
      registers,
    }),
    // Without this, a backlog of 0 means either "nothing to publish" or "no
    // worker is running", and an alert cannot tell them apart.
    outboxRelayUp: new Gauge({
      name: 'outbox_relay_up',
      help: '1 when an outbox relay reported a cycle recently, 0 when none has.',
      registers,
    }),
    outboxRelayCycleSeconds: new Histogram({
      name: 'outbox_relay_cycle_seconds',
      help: 'Duration of an outbox relay cycle, as reported by the relay.',
      buckets: RELAY_CYCLE_BUCKETS,
      registers,
    }),
    dbPoolConnections: new Gauge({
      name: 'db_pool_connections',
      help: 'Connections the runtime database role holds, by the state Postgres reports.',
      labelNames: ['state'],
      registers,
    }),
    dbUp: new Gauge({
      name: 'db_up',
      help: '1 when the readiness probe reached Postgres, 0 when it did not.',
      registers,
    }),
    redisUp: new Gauge({
      name: 'redis_up',
      help: '1 when the readiness probe reached Redis, 0 when it did not.',
      registers,
    }),
    socketConnections: new Gauge({
      name: 'socket_connections',
      help: 'Open Socket.IO connections on this replica, by namespace.',
      labelNames: ['namespace'],
      registers,
    }),
  };
};
