import type { RateLimiter, RateLimitRule } from '../../auth/rate-limit.js';

/**
 * Per IP and brand, on the help center's "Was this helpful?" post (M18-11).
 * Generous, because an office behind one address reads the same help center,
 * and no CAPTCHA, because one on a feedback button costs more votes than it
 * saves (M18 plan, CAPTCHA).
 */
export const HC_FEEDBACK_IP_RULE: RateLimitRule = {
  bucket: 'hc-feedback-ip',
  limit: 30,
  windowSeconds: 15 * 60,
};

/** True when one more vote from this address is allowed, and counts it. */
export const feedbackBudget =
  (limiter: RateLimiter) =>
  (brandId: string, ip: string): Promise<boolean> =>
    limiter.consume(HC_FEEDBACK_IP_RULE, `${brandId}:${ip}`);
