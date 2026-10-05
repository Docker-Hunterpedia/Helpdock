import { REALTIME_EVENTS } from '@helpdock/schemas';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';

/**
 * The `/staff` events that cost Redis work on every call, limited per principal
 * across every socket and replica, the way HTTP is (REQUIREMENTS §5.1). The
 * window is the same sliding one the sign-in form uses, in the same Redis, so
 * opening more sockets or reaching another replica buys nothing.
 *
 * The budgets are a well-behaved client's several times over: the admin joins a
 * handful of rooms per screen, sets presence when a person clicks, and
 * heartbeats every 25 s per socket — sixty a minute is twenty-five open tabs.
 */
export const SOCKET_EVENT_RULES = {
  [REALTIME_EVENTS.roomJoin]: { bucket: 'socket-room-join', limit: 120, windowSeconds: 60 },
  [REALTIME_EVENTS.presenceSet]: { bucket: 'socket-presence-set', limit: 30, windowSeconds: 60 },
  [REALTIME_EVENTS.presenceHeartbeat]: {
    bucket: 'socket-presence-heartbeat',
    limit: 60,
    windowSeconds: 60,
  },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitedSocketEvent = keyof typeof SOCKET_EVENT_RULES;

export interface SocketEventLimiter {
  /** True when the event is allowed and has been counted. */
  consume(event: RateLimitedSocketEvent, principalId: string): Promise<boolean>;
}

export class RedisSocketEventLimiter implements SocketEventLimiter {
  readonly #limiter: Pick<RateLimiter, 'consume'>;

  constructor(limiter: Pick<RateLimiter, 'consume'>) {
    this.#limiter = limiter;
  }

  consume(event: RateLimitedSocketEvent, principalId: string): Promise<boolean> {
    return this.#limiter.consume(SOCKET_EVENT_RULES[event], principalId);
  }
}
