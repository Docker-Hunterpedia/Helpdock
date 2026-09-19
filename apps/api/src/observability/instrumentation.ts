import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resolveTracing } from './tracing.js';

/**
 * OpenTelemetry, started before the application (ARCHITECTURE §14).
 *
 * This module is preloaded with `node --import ./dist/observability/instrumentation.js`,
 * which is not a style preference: an instrumentation works by replacing the
 * exports of the module it patches, so it has to run before anything has
 * imported `http`, `fastify` or `ioredis`. Importing it from `main.ts` would be
 * too late for every one of them.
 *
 * It exports nothing and is imported by nothing: the `--import` flag is the only
 * caller, and the `dev` and `start` scripts and `docker/Dockerfile` all carry
 * it. A new way of starting the process has to carry it too, or tracing is
 * silently off with nothing to notice.
 *
 * **What is instrumented, and what is not.** `http` gives the server and client
 * spans, `fastify` names them by route, `ioredis` covers Redis and, through it,
 * BullMQ's Redis traffic. Two gaps, both deliberate and both verified against
 * `open-telemetry/opentelemetry-js-contrib`:
 *
 * - **Postgres.** `@opentelemetry/instrumentation-pg` patches `pg`
 *   (node-postgres). Helpdock uses `postgres` (porsager) per ARCHITECTURE §1,
 *   which contrib has no instrumentation for, so database calls appear as the
 *   time spent inside their parent span rather than as spans of their own.
 * - **BullMQ.** Contrib has no BullMQ instrumentation. BullMQ ships its own
 *   telemetry interface, wired per queue and worker rather than by patching, so
 *   adopting it is a change to `@helpdock/jobs` and a dependency decision of its
 *   own. Until then a job is traced as the Redis calls it makes.
 *
 * Both are documented in `docs/guides/operations.md` so an operator reading a
 * trace knows why it looks the way it does rather than assuming it is broken.
 */

const tracing = resolveTracing();

if (tracing.enabled) {
  const sdk = new NodeSDK({
    serviceName: tracing.serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();

  // Spans are batched, so an exit that does not flush loses the last few
  // seconds of them — which are the ones around whatever made the process exit.
  const shutdown = (): void => {
    void sdk.shutdown().catch(() => {
      // A collector that has already gone is not worth a second error on the
      // way out; the process is leaving either way.
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
