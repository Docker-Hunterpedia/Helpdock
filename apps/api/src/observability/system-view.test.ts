import type { RelayStatus } from '@helpdock/jobs';
import type { QueueCounts, SystemCheck } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  checksStatus,
  dependencyStatus,
  queuePageView,
  queuesView,
  RELAY_STALE_MS,
  relayView,
  SLOW_CHECK_MS,
} from './system-view.js';

const check = (name: SystemCheck['name'], overrides: Partial<SystemCheck> = {}): SystemCheck => ({
  name,
  status: 'up',
  latencyMs: 4,
  ...overrides,
});

const queue = (name: string, failed = 0): QueueCounts => ({
  name,
  waiting: 0,
  active: 0,
  failed,
  delayed: 0,
  completed: 0,
  oldestWaitingSeconds: null,
});

const relayStatus = (overrides: Partial<RelayStatus> = {}): RelayStatus => ({
  at: '2026-09-19T10:00:00.000Z',
  durationMs: 400,
  pending: 0,
  published: 0,
  brands: 0,
  skipped: 0,
  failed: 0,
  ...overrides,
});

const AT = Date.parse('2026-09-19T10:00:00.000Z');

describe('checksStatus', () => {
  it('is ok when everything answered quickly', () => {
    expect(checksStatus([check('database'), check('redis'), check('settings')])).toBe('ok');
  });

  it('warns when something answered but slowly', () => {
    expect(checksStatus([check('database', { latencyMs: SLOW_CHECK_MS + 1 })])).toBe('warning');
  });

  it('errors when something did not answer, however fast the rest were', () => {
    expect(checksStatus([check('database', { status: 'down' }), check('redis')])).toBe('error');
  });
});

describe('dependencyStatus', () => {
  it('is ok when it is reachable and quick', () => {
    expect(dependencyStatus({ reachable: true, latencyMs: 3 })).toBe('ok');
  });

  it('warns on a condition that costs latency without being a failure', () => {
    expect(dependencyStatus({ reachable: true, latencyMs: 3, degraded: true })).toBe('warning');
  });

  it('errors when it is not reachable at all', () => {
    expect(dependencyStatus({ reachable: false, latencyMs: 0 })).toBe('error');
  });
});

describe('relayView', () => {
  it('reports a fresh cycle', () => {
    expect(relayView(relayStatus({ pending: 2, published: 5 }), AT + 1000)).toEqual({
      reporting: true,
      at: '2026-09-19T10:00:00.000Z',
      durationMs: 400,
      pending: 2,
      published: 5,
      failed: 0,
    });
  });

  it('carries the failure count through, so the page can colour it', () => {
    expect(relayView(relayStatus({ failed: 1 }), AT)).toMatchObject({ failed: 1 });
  });

  it('treats a stale cycle as no report at all, rather than showing an old number as current', () => {
    expect(relayView(relayStatus(), AT + RELAY_STALE_MS + 1)).toEqual({ reporting: false });
  });

  it('says so when no relay has ever reported', () => {
    expect(relayView(null, AT)).toEqual({ reporting: false });
  });
});

describe('queuesView', () => {
  it('takes the first n and still counts every queue and every failed job', () => {
    const all = [queue('a', 1), queue('b'), queue('c', 2), queue('d'), queue('e'), queue('f')];

    expect(queuesView(all, 5)).toEqual({
      queues: all.slice(0, 5),
      total: 6,
      deadLettered: 3,
    });
  });
});

describe('queuePageView', () => {
  it('returns the page asked for and the totals for the whole list', () => {
    const all = [queue('a'), queue('b', 4), queue('c')];

    expect(queuePageView(all, { page: 2, pageSize: 2 })).toEqual({
      queues: [queue('c')],
      total: 3,
      deadLettered: 4,
      page: 2,
      pageSize: 2,
    });
  });

  it('returns nothing for a page past the end rather than wrapping round', () => {
    expect(queuePageView([queue('a')], { page: 9, pageSize: 25 }).queues).toEqual([]);
  });
});
