import { RateLimited } from './errors.js';

/** Retry-After accepts delta-seconds or an HTTP date; invalid or elapsed values use one second. */
export function retryAfterMs(header: string | undefined, now = Date.now()): number {
  if (header === undefined) return 1000;
  const seconds = /^\d+$/.test(header.trim()) ? Number(header.trim()) : Number.NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isSafeInteger(delay) && delay > 0 ? delay : 1000;
}

/** Non-blocking token bucket: the worker persists the next delay rather than holding a socket or timer. */
export class ImportRateLimiter {
  #tokens: number;
  #updatedAt: number;
  #blockedUntil = 0;

  constructor(
    private readonly options: { capacity: number; perMinute: number; now?: () => number },
  ) {
    if (
      !Number.isFinite(options.capacity) ||
      options.capacity < 1 ||
      !Number.isFinite(options.perMinute) ||
      options.perMinute <= 0
    )
      throw new RangeError('Rate budgets must be positive');
    this.#tokens = options.capacity;
    this.#updatedAt = this.#now();
  }

  reserve(): void {
    const now = this.#now();
    if (this.#blockedUntil > now) throw new RateLimited(Math.ceil(this.#blockedUntil - now));
    this.#tokens = Math.min(
      this.options.capacity,
      this.#tokens + (Math.max(0, now - this.#updatedAt) * this.options.perMinute) / 60000,
    );
    this.#updatedAt = now;
    if (this.#tokens < 1)
      throw new RateLimited(
        Math.max(1, Math.ceil(((1 - this.#tokens) * 60000) / this.options.perMinute)),
      );
    this.#tokens -= 1;
  }

  defer(delay: number): void {
    const refusal = new RateLimited(delay);
    this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + refusal.retryAfterMs);
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
