import { describe, expect, it } from 'vitest';
import { resolveTracing } from './tracing.js';

describe('resolveTracing', () => {
  it('is off when no OTLP endpoint is configured', () => {
    expect(resolveTracing({})).toMatchObject({ enabled: false, endpoint: undefined });
  });

  it('is off when the endpoint is set to nothing, which is how a compose file clears it', () => {
    expect(resolveTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' }).enabled).toBe(false);
  });

  it('is on when the standard endpoint variable is set', () => {
    expect(resolveTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toMatchObject({
      enabled: true,
      endpoint: 'http://collector:4318',
    });
  });

  it('prefers the traces-specific endpoint, as the OTLP spec says to', () => {
    expect(
      resolveTracing({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
      }).endpoint,
    ).toBe('http://traces:4318/v1/traces');
  });

  it('names the two roles apart, so one image is two services in a trace view', () => {
    expect(resolveTracing({ APP_ROLE: 'api' }).serviceName).toBe('helpdock-api');
    expect(resolveTracing({ APP_ROLE: 'worker' }).serviceName).toBe('helpdock-worker');
  });

  it('lets the standard override win', () => {
    expect(
      resolveTracing({ APP_ROLE: 'worker', OTEL_SERVICE_NAME: 'support-desk' }).serviceName,
    ).toBe('support-desk');
  });
});
