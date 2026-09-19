import { describe, expect, it, vi } from 'vitest';
import {
  RELAY_STATUS_KEY,
  RELAY_STATUS_TTL_SECONDS,
  type RelayStatus,
  type RelayStatusStore,
  readRelayStatus,
  relayStatusSchema,
  writeRelayStatus,
} from './relay-status.js';

const status: RelayStatus = {
  at: '2026-09-19T10:00:00.000Z',
  durationMs: 412,
  pending: 3,
  published: 2,
  brands: 1,
  skipped: 0,
  failed: 0,
};

/** A Redis with one key in it, which is all the status needs. */
const fakeStore = (initial: string | null = null) => {
  let value = initial;

  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (_key: string, next: string) => {
      value = next;
      return 'OK';
    }),
  } satisfies RelayStatusStore;
};

describe('writeRelayStatus', () => {
  it('writes the cycle under the documented key with an expiry', async () => {
    const store = fakeStore();

    await writeRelayStatus(store, status);

    expect(store.set).toHaveBeenCalledWith(
      RELAY_STATUS_KEY,
      expect.any(String),
      'EX',
      RELAY_STATUS_TTL_SECONDS,
    );
    // The content, not the key order the schema happens to produce.
    expect(JSON.parse(store.set.mock.calls[0]?.[1] ?? '')).toEqual(status);
  });

  it('refuses a status that does not match the schema, rather than writing it', async () => {
    const store = fakeStore();

    await expect(writeRelayStatus(store, { ...status, pending: -1 })).rejects.toThrow();
    expect(store.set).not.toHaveBeenCalled();
  });
});

describe('readRelayStatus', () => {
  it('round-trips what the relay wrote', async () => {
    const store = fakeStore();
    await writeRelayStatus(store, status);

    expect(await readRelayStatus(store)).toEqual(status);
  });

  it('is null when no relay has reported', async () => {
    expect(await readRelayStatus(fakeStore(null))).toBeNull();
  });

  it.each([
    ['content that is not JSON', 'not json at all'],
    ['JSON that is not a status', '{"at":"yesterday"}'],
    ['a status with a field of the wrong type', '{"at":"2026-09-19T10:00:00.000Z","pending":"3"}'],
  ])('is null for %s, so a status panel cannot be broken from Redis', async (_name, raw) => {
    expect(await readRelayStatus(fakeStore(raw))).toBeNull();
  });
});

describe('relayStatusSchema', () => {
  it('requires an ISO timestamp, so the page can say how long ago the cycle was', () => {
    expect(relayStatusSchema.safeParse({ ...status, at: '19/09/2026' }).success).toBe(false);
  });
});
