import { describe, expect, it } from 'vitest';
import { createMetrics } from './metrics.js';

/** Every metric ARCHITECTURE §14 names, by the name a dashboard will query. */
const DECLARED = [
  'http_request_duration_seconds',
  'http_requests_total',
  'queue_jobs',
  'outbox_unpublished_rows',
  'outbox_relay_up',
  'outbox_relay_cycle_seconds',
  'db_pool_connections',
  'db_up',
  'redis_up',
  'socket_connections',
] as const;

describe('createMetrics', () => {
  it('registers every metric the spec names', async () => {
    const scrape = await createMetrics().registry.metrics();

    for (const name of DECLARED) {
      expect(scrape, name).toContain(`# TYPE ${name} `);
    }
  });

  it('collects the default Node metrics too', async () => {
    const scrape = await createMetrics().registry.metrics();

    expect(scrape).toContain('nodejs_eventloop_lag_seconds');
    expect(scrape).toContain('process_resident_memory_bytes');
  });

  it('gives each call its own registry, so two instances cannot collide', async () => {
    const first = createMetrics();
    const second = createMetrics();

    first.socketConnections.set({ namespace: '/staff' }, 7);

    expect(await first.registry.metrics()).toContain('socket_connections{namespace="/staff"} 7');
    expect(await second.registry.metrics()).not.toContain('socket_connections{');
  });
});
