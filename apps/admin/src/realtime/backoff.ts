/**
 * How long to wait before trying the socket again.
 *
 * Exponential with full jitter, which is the standard answer to the one failure
 * mode a reconnect loop has: an api replica restarting and every open admin tab
 * coming back at the same instant. Jitter spreads them; the cap keeps a long
 * outage from turning into a ten-minute wait once it ends.
 */

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

export const backoffDelay = (attempt: number, random: () => number = Math.random): number => {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));

  return Math.round(random() * ceiling);
};
