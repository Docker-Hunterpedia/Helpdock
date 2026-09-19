import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Metrics } from './metrics.js';
import { MILLIS_PER_SECOND } from './time.js';

/**
 * `http_request_duration_seconds` and `http_requests_total`, recorded from a
 * Fastify `onResponse` hook rather than from a Nest interceptor.
 *
 * The difference matters. A Nest interceptor runs *after* the guards, so every
 * 401 and 403 — the responses an operator most wants to see a rate of — would
 * be missing, and so would a 404, which never reaches a controller at all. The
 * hook runs for everything Fastify answers.
 */

/**
 * The label for a request that matched no route. Without it every scan and
 * typo'd path would mint a new time series, which is how a metrics endpoint
 * becomes a denial of service against its own scraper.
 */
export const UNMATCHED_ROUTE = '__unmatched__';

/**
 * Fastify carries the route *template* it matched — `/api/brands/:brandId` —
 * which is exactly the label Prometheus wants: one series per route, whatever
 * the ids in it. `request.url` is the opposite and must never be used: it
 * carries ids and a query string, so it would be both unbounded cardinality and
 * a way for a search term to end up in a metric.
 */
export const routeLabel = (routeUrl: string | undefined): string =>
  routeUrl === undefined || routeUrl === '' ? UNMATCHED_ROUTE : routeUrl;

export const recordResponse = (
  metrics: Metrics,
  { route, method, status, durationMs }: RecordedResponse,
): void => {
  const labels = { route, method, status: String(status) };

  metrics.httpRequestDuration.observe(labels, durationMs / MILLIS_PER_SECOND);
  metrics.httpRequestsTotal.inc(labels);
};

export interface RecordedResponse {
  readonly route: string;
  readonly method: string;
  readonly status: number;
  readonly durationMs: number;
}

/** What the hook reads off a finished request. Exported so a test can drive it. */
export const responseOf = (request: FastifyRequest, reply: FastifyReply): RecordedResponse => ({
  route: routeLabel(request.routeOptions.url),
  method: request.method,
  status: reply.statusCode,
  // `elapsedTime` is measured by Fastify from the start of the request, which
  // is earlier than anything this app could time for itself.
  durationMs: reply.elapsedTime,
});

export const registerHttpMetrics = (fastify: FastifyInstance, metrics: Metrics): void => {
  fastify.addHook('onResponse', (request, reply, done) => {
    recordResponse(metrics, responseOf(request, reply));
    done();
  });
};
