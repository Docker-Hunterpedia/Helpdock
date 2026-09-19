import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { quietly, unawaitedUnsubscribeIsSafe } from './redis-io.adapter.js';

/** A client whose commands fail the way ioredis's do once Redis has gone. */
const goneRedis = (): Redis & { disconnected: number } => {
  const client = {
    disconnected: 0,
    unsubscribe: () => Promise.reject(new Error('Connection is closed.')),
    punsubscribe: () => Promise.reject(new Error('Connection is closed.')),
    subscribe: () => Promise.reject(new Error('Connection is closed.')),
    quit: () => Promise.reject(new Error('Connection is closed.')),
    disconnect: () => {
      client.disconnected += 1;
    },
    status: 'end',
  };

  // biome-ignore lint/suspicious/noExplicitAny: the double implements what these two helpers touch.
  return client as any;
};

describe('unawaitedUnsubscribeIsSafe', () => {
  it.each(['unsubscribe', 'punsubscribe'] as const)(
    'swallows a failed %s, which the adapter fires without awaiting',
    async (method) => {
      const client = unawaitedUnsubscribeIsSafe(goneRedis());

      await expect(client[method]('channel')).resolves.toBeUndefined();
    },
  );

  it('leaves every other command to reject as it would', async () => {
    const client = unawaitedUnsubscribeIsSafe(goneRedis());

    await expect(client.subscribe('channel')).rejects.toThrow('Connection is closed.');
  });

  it('hands non-function properties through untouched', () => {
    expect(unawaitedUnsubscribeIsSafe(goneRedis()).status).toBe('end');
  });
});

describe('quietly', () => {
  it('does nothing for a connection that was never opened', async () => {
    await expect(quietly(null)).resolves.toBeUndefined();
  });

  it('closes a connection that answers', async () => {
    const quit = vi.fn(() => Promise.resolve('OK' as const));
    const disconnect = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: `quietly` calls exactly these two.
    await quietly({ quit, disconnect } as any);

    expect(quit).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('drops a connection that cannot be asked nicely, rather than hanging the shutdown', async () => {
    const client = goneRedis();

    await quietly(client);

    expect(client.disconnected).toBe(1);
  });
});
