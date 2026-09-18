import { describe, expect, it } from 'vitest';
import { createWaiter } from './waiter.js';

/** Resolves once the event loop has turned, so a pending `wait` has started. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createWaiter', () => {
  it('resolves after the timeout when nothing notifies', async () => {
    const started = Date.now();
    await createWaiter().wait(20);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('ends a wait in progress at once', async () => {
    const waiter = createWaiter();
    const started = Date.now();

    const waiting = waiter.wait(60_000);
    await tick();
    waiter.notify();
    await waiting;

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('redeems a notification that arrived while nobody was waiting', async () => {
    const waiter = createWaiter();
    waiter.notify();

    const started = Date.now();
    await waiter.wait(60_000);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('spends a redeemed notification only once', async () => {
    const waiter = createWaiter();
    waiter.notify();
    await waiter.wait(60_000);

    const started = Date.now();
    await waiter.wait(20);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('leaves no notification behind after one interrupted a wait', async () => {
    const waiter = createWaiter();

    const waiting = waiter.wait(60_000);
    await tick();
    waiter.notify();
    await waiting;

    const started = Date.now();
    await waiter.wait(20);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
