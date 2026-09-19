/**
 * Whether to trace, and as what.
 *
 * The endpoint is read from `OTEL_EXPORTER_OTLP_ENDPOINT`, the standard
 * OpenTelemetry variable, and deliberately **not** from the `@helpdock/config`
 * schema. Two reasons: the SDK starts before `loadEnv()` can run, since it has
 * to patch `http` before anything imports it; and every OpenTelemetry tool an
 * operator already has — collectors, agents, documentation — speaks these
 * variable names. A second Helpdock-specific name for the same thing would only
 * be a name that can disagree.
 *
 * Without the endpoint the SDK is not started at all. That is the no-op: no
 * exporter, no batching, no background flush, nothing patched.
 */

/** The service name spans are attributed to, before the role is appended. */
const SERVICE_NAME = 'helpdock';

export interface TracingConfig {
  readonly enabled: boolean;
  readonly endpoint: string | undefined;
  readonly serviceName: string;
}

export interface TracingEnvironment {
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  readonly OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string | undefined;
  readonly OTEL_SERVICE_NAME?: string | undefined;
  readonly APP_ROLE?: string | undefined;
}

/**
 * `helpdock-api` or `helpdock-worker`, so the two halves of one image are
 * separable in a trace view without an operator configuring anything.
 * `OTEL_SERVICE_NAME` still wins, because it is the standard override.
 */
export const resolveTracing = (env: TracingEnvironment = process.env): TracingConfig => {
  const endpoint = (
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    ''
  ).trim();

  const role = env.APP_ROLE === 'worker' ? 'worker' : 'api';

  return {
    enabled: endpoint !== '',
    endpoint: endpoint === '' ? undefined : endpoint,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || `${SERVICE_NAME}-${role}`,
  };
};
