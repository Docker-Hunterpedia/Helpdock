import type { RelayStatus } from '@helpdock/jobs';
import type { QueueCounts } from '@helpdock/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from './metrics.js';
import {
  MetricsSampler,
  recordDependency,
  recordPoolConnections,
  recordQueueCounts,
  recordRelayStatus,
} from './metrics-sampler.js';
import { RELAY_STALE_MS } from './system-view.js';

const counts = (name: string, overrides: Partial<QueueCounts> = {}): QueueCounts => ({
  name,
  waiting: 0,
  active: 0,
  failed: 0,
  delayed: 0,
  completed: 0,
  oldestWaitingSeconds: null,
  ...overrides,
});

const status = (overrides: Partial<RelayStatus> = {}): RelayStatus => ({
  at: '2026-09-19T10:00:00.000Z',
  durationMs: 400,
  pending: 0,
  published: 0,
  brands: 0,
  skipped: 0,
  failed: 0,
  ...overrides,
});

const silent = { warn: () => {} };

describe('recordQueueCounts', () => {
  it('sets one series per queue and state', async () => {
    const metrics = createMetrics();

    recordQueueCounts(metrics, [counts('outbound', { waiting: 3, failed: 2 })]);

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('queue_jobs{queue="outbound",state="waiting"} 3');
    expect(scrape).toContain('queue_jobs{queue="outbound",state="failed"} 2');
    expect(scrape).toContain('queue_jobs{queue="outbound",state="active"} 0');
  });
});

describe('recordRelayStatus', () => {
  it('publishes the backlog and observes the cycle once', async () => {
    const metrics = createMetrics();

    const seen = recordRelayStatus(metrics, status({ pending: 4, durationMs: 500 }), null);

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('outbox_unpublished_rows 4');
    expect(scrape).toContain('outbox_relay_up 1');
    expect(scrape).toContain('outbox_relay_cycle_seconds_count 1');
    expect(scrape).toContain('outbox_relay_cycle_seconds_sum 0.5');
    expect(seen).toBe('2026-09-19T10:00:00.000Z');
  });

  it('does not count the same reported cycle twice when the relay has not moved on', async () => {
    const metrics = createMetrics();

    const first = recordRelayStatus(metrics, status({ durationMs: 500 }), null);
    recordRelayStatus(metrics, status({ durationMs: 500 }), first);

    expect(await metrics.registry.metrics()).toContain('outbox_relay_cycle_seconds_count 1');
  });

  it('counts the next cycle when it is a different one', async () => {
    const metrics = createMetrics();

    const first = recordRelayStatus(metrics, status(), null);
    recordRelayStatus(metrics, status({ at: '2026-09-19T10:00:01.000Z' }), first);

    expect(await metrics.registry.metrics()).toContain('outbox_relay_cycle_seconds_count 2');
  });

  it('marks a stale heartbeat down at the same point the System page does', async () => {
    const metrics = createMetrics();
    const at = '2026-09-19T10:00:00.000Z';
    const stale = Date.parse(at) + RELAY_STALE_MS + 1;

    recordRelayStatus(metrics, status({ at, pending: 4 }), null, stale);

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('outbox_relay_up 0');
    expect(scrape).toContain('outbox_unpublished_rows 0');
  });

  it('marks the relay down when none is reporting, so a zero backlog is not read as health', async () => {
    const metrics = createMetrics();

    const seen = recordRelayStatus(metrics, null, '2026-09-19T10:00:00.000Z');

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('outbox_unpublished_rows 0');
    expect(scrape).toContain('outbox_relay_up 0');
    expect(scrape).toContain('outbox_relay_cycle_seconds_count 0');
    // The last cycle is remembered, so a relay that comes back with the same
    // report is still not double-counted.
    expect(seen).toBe('2026-09-19T10:00:00.000Z');
  });
});

describe('recordDependency', () => {
  it('is 1 when the probe answered and 0 when it did not', async () => {
    const metrics = createMetrics();

    recordDependency(metrics, { database: true, redis: false });

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('db_up 1');
    expect(scrape).toContain('redis_up 0');
  });
});

describe('recordPoolConnections', () => {
  it('replaces the previous reading rather than adding to it', async () => {
    const metrics = createMetrics();

    recordPoolConnections(
      metrics,
      new Map([
        ['active', 3],
        ['idle', 5],
      ]),
    );
    recordPoolConnections(metrics, new Map([['idle', 2]]));

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('db_pool_connections{state="idle"} 2');
    // A state that has gone away must not be left behind at its old value.
    expect(scrape).not.toContain('state="active"');
  });
});

describe('MetricsSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('samples on the interval until it is stopped', async () => {
    const sample = vi.fn(async () => {});
    const sampler = new MetricsSampler({ sample, log: silent, intervalMs: 1000 });

    sampler.start();
    // Starting twice must not double the rate.
    sampler.start();

    await vi.advanceTimersByTimeAsync(3000);
    expect(sample).toHaveBeenCalledTimes(3);

    sampler.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sample).toHaveBeenCalledTimes(3);
  });

  it('logs a failed sample and keeps going, because a reading is not worth a crash', async () => {
    const warn = vi.fn();
    const sample = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis went away'))
      .mockResolvedValue(undefined);
    const sampler = new MetricsSampler({ sample, log: { warn }, intervalMs: 1000 });

    sampler.start();
    await vi.advanceTimersByTimeAsync(2000);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenCalledTimes(2);
    sampler.stop();
  });

  it('a sampler that was never started stops without sampling', async () => {
    const sample = vi.fn(async () => {});
    const sampler = new MetricsSampler({ sample, log: silent, intervalMs: 1000 });

    sampler.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(sample).not.toHaveBeenCalled();
  });
});
