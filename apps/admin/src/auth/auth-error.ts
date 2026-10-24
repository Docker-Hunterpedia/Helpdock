import { isAuthError } from './api.js';

export const retryAfterMinutes = (retryAfter: number | undefined): number =>
  Math.max(1, Math.ceil((retryAfter ?? 900) / 60));

/**
 * The install has no system sender (#369): no link can go out, and the answer
 * must say so instead of sending the person to an inbox nothing will ever
 * reach. The same for every address — it says how the install is configured,
 * never which accounts exist (DOMAIN-RULES §12).
 */
export const isEmailUnavailable = (error: unknown): boolean =>
  isAuthError(error) && error.code === 'email-unavailable';
