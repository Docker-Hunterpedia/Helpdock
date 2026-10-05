import type { Counter } from 'prom-client';

/**
 * Where every rate limit reports a refusal, for `rate_limit_refusals_total`
 * (ASVS 8.1.4, 11.1.8). The limits themselves refuse; this is what lets an
 * operator be told that they are refusing a lot (the alert is in
 * `docs/guides/operations.md`).
 *
 * The limiters are built inside half a dozen module factories, some of them in
 * a field initialiser of a controller, and none of them is otherwise a reason to
 * know the metrics registry. So boot points this at the counter once, and until
 * it does — in a unit test, in the worker, which serves no requests — a refusal
 * is counted nowhere.
 */

export interface RateLimitRefusals {
  record(bucket: string): void;
}

const uncounted: RateLimitRefusals = { record: () => {} };

let sink: RateLimitRefusals = uncounted;

export const countRateLimitRefusalsIn = (counter: Counter<'bucket'>): void => {
  sink = {
    record: (bucket) => {
      counter.inc({ bucket });
    },
  };
};

/** Read at the moment of refusal, so a limiter built before boot finished still counts. */
export const rateLimitRefusals = (): RateLimitRefusals => sink;
