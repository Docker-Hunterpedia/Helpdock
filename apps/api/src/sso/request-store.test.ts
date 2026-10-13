import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SsoRequestStore } from './request-store.js';

describe('SSO request state', () => {
  it('refuses reuse without replacing a live request', async () => {
    const redis = { set: vi.fn().mockResolvedValue(null) } as unknown as Redis;
    const store = new SsoRequestStore(redis, 'oidc', z.object({ nonce: z.string() }));
    await expect(store.put('a'.repeat(32), { nonce: 'nonce' })).rejects.toThrow('already exists');
  });
  it.each([null, JSON.stringify({ wrong: 'shape' })])(
    'refuses absent or malformed request data',
    async (raw) => {
      const redis = { getdel: vi.fn().mockResolvedValue(raw) } as unknown as Redis;
      const store = new SsoRequestStore(redis, 'oidc', z.object({ nonce: z.string() }));
      expect(await store.consume('a'.repeat(32))).toBeNull();
    },
  );
  it('validates the record before persisting state', async () => {
    const redis = { set: vi.fn() } as unknown as Redis;
    const store = new SsoRequestStore(redis, 'oidc', z.object({ nonce: z.string().min(16) }));
    await expect(store.put('a'.repeat(32), { nonce: 'short' })).rejects.toThrow();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
