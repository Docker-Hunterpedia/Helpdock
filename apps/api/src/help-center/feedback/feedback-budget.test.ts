import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../auth/rate-limit.js';
import { authRedis } from '../../testing/auth-redis.js';
import { feedbackBudget } from './feedback-budget.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const OTHER_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b2';

describe('feedbackBudget', () => {
  it('allows thirty votes from one address per brand, then refuses', async () => {
    const allow = feedbackBudget(new RateLimiter(authRedis().redis));
    const answers: boolean[] = [];
    for (let vote = 0; vote < 31; vote += 1) {
      answers.push(await allow(BRAND, '203.0.113.9'));
    }

    expect(answers.filter(Boolean)).toHaveLength(30);
    expect(answers.at(-1)).toBe(false);
    await expect(allow(OTHER_BRAND, '203.0.113.9')).resolves.toBe(true);
    await expect(allow(BRAND, '203.0.113.10')).resolves.toBe(true);
  });
});
