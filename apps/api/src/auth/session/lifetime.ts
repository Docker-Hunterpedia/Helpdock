import type { Env } from '@helpdock/config';

/**
 * How long a refresh family may live (ASVS 3.3.2).
 *
 * Two clocks. **Idle**: a family that has not been refreshed for this long is
 * gone, so a browser left signed in on a shared machine does not stay signed in
 * forever. **Absolute**: however busy it was, a family ends this long after the
 * sign-in that opened it, so a stolen refresh cookie that is kept fresh by its
 * thief still dies on a known date.
 *
 * The defaults meet ASVS Level 2's figure of re-authentication after twelve
 * hours. A browser the person chose to trust skips the second factor when they
 * sign in again, so the cost of a daily sign-in is one password.
 */

export const DEFAULT_SESSION_IDLE_MINUTES = 240;
export const DEFAULT_SESSION_MAX_HOURS = 12;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

export interface SessionLifetime {
  readonly idleSeconds: number;
  readonly maxSeconds: number;
}

export const sessionLifetime = (
  env: Pick<Env, 'AUTH_SESSION_IDLE_MINUTES' | 'AUTH_SESSION_MAX_HOURS'>,
): SessionLifetime => {
  const maxSeconds = (env.AUTH_SESSION_MAX_HOURS ?? DEFAULT_SESSION_MAX_HOURS) * SECONDS_PER_HOUR;
  const idleSeconds =
    (env.AUTH_SESSION_IDLE_MINUTES ?? DEFAULT_SESSION_IDLE_MINUTES) * SECONDS_PER_MINUTE;

  // An idle limit longer than the absolute one can never be reached.
  return { idleSeconds: Math.min(idleSeconds, maxSeconds), maxSeconds };
};

export const DEFAULT_SESSION_LIFETIME: SessionLifetime = sessionLifetime({});
