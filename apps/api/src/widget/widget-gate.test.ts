import { describe, expect, it } from 'vitest';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import { WidgetFailure } from './widget-failure.js';
import { WIDGET_SOCKET_EVENT_RULE, WidgetGate } from './widget-gate.js';

/** Counts per bucket and subject, the way the Redis sliding window does. */
const countingLimiter = (): Pick<RateLimiter, 'consume'> & { readonly seen: string[] } => {
  const used = new Map<string, number>();
  const seen: string[] = [];
  return {
    seen,
    consume: (rule: RateLimitRule, subject: string) => {
      const key = `${rule.bucket}:${subject}`;
      const count = (used.get(key) ?? 0) + 1;
      seen.push(rule.bucket);
      if (count > rule.limit) {
        return Promise.resolve(false);
      }
      used.set(key, count);
      return Promise.resolve(true);
    },
  };
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

const outcomeOf = (gate: WidgetGate, visitorId: string): Promise<unknown> =>
  gate.socketEvent(visitorId).then(
    () => 'allowed',
    (error: unknown) => error,
  );

const spend = async (gate: WidgetGate, visitorId: string, count: number): Promise<unknown[]> => {
  const outcomes: unknown[] = [];
  for (let event = 0; event < count; event += 1) {
    outcomes.push(await outcomeOf(gate, visitorId));
  }
  return outcomes;
};

describe('WidgetGate.socketEvent (F1, M9-01)', () => {
  it('lets a visitor spend exactly the socket-event budget, then answers rate_limited', async () => {
    const outcomes = await spend(
      gateWith(countingLimiter()),
      'visitor-a',
      WIDGET_SOCKET_EVENT_RULE.limit + 1,
    );

    expect(outcomes.slice(0, -1).every((outcome) => outcome === 'allowed')).toBe(true);
    const refusal = outcomes.at(-1);
    expect(refusal).toBeInstanceOf(WidgetFailure);
    expect((refusal as WidgetFailure).reason).toBe('rate_limited');
  });

  it('keeps one visitor’s flood from spending another visitor’s budget', async () => {
    const gate = gateWith(countingLimiter());
    await spend(gate, 'visitor-a', WIDGET_SOCKET_EVENT_RULE.limit + 1);

    expect(await outcomeOf(gate, 'visitor-b')).toBe('allowed');
  });

  it('charges its own bucket, so rate_limit_refusals_total names the socket budget', async () => {
    const limiter = countingLimiter();

    await outcomeOf(gateWith(limiter), 'visitor-a');

    expect(limiter.seen).toEqual(['widget-socket-event']);
  });
});
