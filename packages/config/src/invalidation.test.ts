import { describe, expect, it, vi } from 'vitest';
import { LocalInvalidation } from './invalidation.js';

describe('LocalInvalidation', () => {
  it('delivers a published key to every subscriber', async () => {
    const invalidation = new LocalInvalidation();
    const first = vi.fn();
    const second = vi.fn();
    invalidation.subscribe(first);
    invalidation.subscribe(second);

    await invalidation.publish('smtp.host');

    expect(first).toHaveBeenCalledExactlyOnceWith('smtp.host');
    expect(second).toHaveBeenCalledExactlyOnceWith('smtp.host');
  });

  it('stops delivering once a subscriber unsubscribes', async () => {
    const invalidation = new LocalInvalidation();
    const handler = vi.fn();
    const unsubscribe = invalidation.subscribe(handler);

    await invalidation.publish('smtp.host');
    unsubscribe();
    await invalidation.publish('smtp.port');

    expect(handler).toHaveBeenCalledExactlyOnceWith('smtp.host');
  });

  it('delivers nothing once closed', async () => {
    const invalidation = new LocalInvalidation();
    const handler = vi.fn();
    invalidation.subscribe(handler);

    await invalidation.close();
    await invalidation.publish('smtp.host');

    expect(handler).not.toHaveBeenCalled();
  });
});
