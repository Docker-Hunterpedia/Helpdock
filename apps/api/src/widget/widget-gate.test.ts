import { describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '../auth/rate-limit.js';
import { WidgetFailure } from './widget-failure.js';
import { WIDGET_SOCKET_EVENT_RULE, WidgetGate } from './widget-gate.js';

/** The shared limiter's one answer; the sliding window itself is Redis's and has its own suite. */
const limiterAnswering = (allowed: boolean) => {
  const consume = vi.fn<RateLimiter['consume']>(async () => allowed);
  return { consume };
};

/** A dependency that fails the test the moment the gate reaches for it. */
const notReachedBeforeTheBudget = new Proxy(
  {},
  {
    get: () => {
      throw new Error('a socket event touched Postgres before its budget was checked');
    },
  },
);

const gateWith = (limiter: Pick<RateLimiter, 'consume'>): WidgetGate =>
  new WidgetGate({
    db: notReachedBeforeTheBudget as never,
    settings: notReachedBeforeTheBudget as never,
    widget: notReachedBeforeTheBudget as never,
    limiter,
  });

describe('WidgetGate.socketEvent (F1, M9-01)', () => {
  it('answers rate_limited once the visitor’s budget is spent', async () => {
    const refusal = await gateWith(limiterAnswering(false))
      .socketEvent('visitor-a')
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(WidgetFailure);
    expect((refusal as WidgetFailure).reason).toBe('rate_limited');
  });

  it('lets an event through while the budget lasts, charged to its own bucket and to the visitor', async () => {
    const limiter = limiterAnswering(true);

    await expect(gateWith(limiter).socketEvent('visitor-a')).resolves.toBeUndefined();

    // The bucket names rate_limit_refusals_total; the subject is what makes
    // the budget the visitor's across every socket and replica.
    expect(limiter.consume).toHaveBeenCalledExactlyOnceWith(WIDGET_SOCKET_EVENT_RULE, 'visitor-a');
  });
});
