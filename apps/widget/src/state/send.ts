import { TransportError } from '../transport/types.js';

/** DOMAIN-RULES §7: "after a timeout of 10 seconds with retries it shows 'not sent, retry'". */
export const SEND_WINDOW_MS = 10_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000] as const;

/** Errors a retry cannot fix: the same request would be refused again. */
const FINAL: ReadonlySet<string> = new Set(['policy_rejected', 'captcha_failed', 'not_found']);

export function isRetryable(error: unknown): boolean {
  return !(error instanceof TransportError && FINAL.has(error.code));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls `attempt` until it resolves or `windowMs` has passed since the first
 * try. The caller must make every attempt idempotent (same `client_id`), so a
 * try that reached the server but lost its answer is harmless.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  windowMs: number = SEND_WINDOW_MS,
): Promise<T> {
  const deadline = Date.now() + windowMs;

  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const delay = BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)] ?? 0;
      if (!isRetryable(error) || Date.now() + delay >= deadline) {
        throw error;
      }
      await wait(delay);
    }
  }
}

/** UUIDv7 (RFC 9562): time-ordered, so the server's index on `client_id` stays compact. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
