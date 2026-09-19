import { describe, expect, it } from 'vitest';
import {
  channelStatusSchema,
  queueCountsSchema,
  systemAiSpendSchema,
  systemQueuesQuerySchema,
  systemRelaySchema,
  systemStorageSchema,
} from './system.js';

describe('systemStorageSchema', () => {
  it('accepts the unconfigured shape on its own, with no room for a fake number', () => {
    expect(systemStorageSchema.parse({ configured: false })).toEqual({ configured: false });
    expect(systemStorageSchema.parse({ configured: false, usedBytes: 999 })).toEqual({
      configured: false,
    });
  });

  it('requires a measurement once it says it is configured', () => {
    expect(systemStorageSchema.safeParse({ configured: true }).success).toBe(false);
    expect(
      systemStorageSchema.safeParse({ configured: true, usedBytes: 0, softLimitBytes: null })
        .success,
    ).toBe(true);
  });
});

describe('systemAiSpendSchema', () => {
  it('tells "not configured" apart from "configured and zero"', () => {
    expect(systemAiSpendSchema.safeParse({ configured: false }).success).toBe(true);
    expect(
      systemAiSpendSchema.safeParse({
        configured: true,
        tokens: 0,
        costUsd: 0,
        budgetUsd: 10,
        alertAtPercent: 80,
      }).success,
    ).toBe(true);
  });

  it('refuses an alert threshold outside a percentage', () => {
    expect(
      systemAiSpendSchema.safeParse({
        configured: true,
        tokens: 0,
        costUsd: 0,
        budgetUsd: 10,
        alertAtPercent: 140,
      }).success,
    ).toBe(false);
  });
});

describe('systemRelaySchema', () => {
  it('carries nothing at all when no relay is reporting', () => {
    expect(systemRelaySchema.parse({ reporting: false })).toEqual({ reporting: false });
  });

  it('requires the cycle when it says one was reported', () => {
    expect(systemRelaySchema.safeParse({ reporting: true, pending: 0 }).success).toBe(false);
  });
});

describe('queueCountsSchema', () => {
  it('allows no oldest waiting job, which is what an empty queue has', () => {
    expect(
      queueCountsSchema.parse({
        name: 'outbound',
        waiting: 0,
        active: 0,
        failed: 0,
        delayed: 0,
        completed: 0,
        oldestWaitingSeconds: null,
      }).oldestWaitingSeconds,
    ).toBeNull();
  });

  it('refuses a negative count, which would only ever be a bug', () => {
    expect(
      queueCountsSchema.safeParse({
        name: 'outbound',
        waiting: -1,
        active: 0,
        failed: 0,
        delayed: 0,
        completed: 0,
        oldestWaitingSeconds: null,
      }).success,
    ).toBe(false);
  });
});

describe('channelStatusSchema', () => {
  it('is the shape M2 and M6 fill, with a status a page can draw', () => {
    expect(
      channelStatusSchema.safeParse({
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
        name: 'Support mailbox',
        kind: 'email',
        status: 'error',
        detail: 'auth failed',
        checkedAt: '2026-09-19T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('systemQueuesQuerySchema', () => {
  it('defaults to the first page', () => {
    expect(systemQueuesQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  it('coerces the strings a query string actually carries', () => {
    expect(systemQueuesQuerySchema.parse({ page: '2', pageSize: '5' })).toEqual({
      page: 2,
      pageSize: 5,
    });
  });

  it('caps the page size, so one request cannot ask for everything', () => {
    expect(systemQueuesQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });
});
