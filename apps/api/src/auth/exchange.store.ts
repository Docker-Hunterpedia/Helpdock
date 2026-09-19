import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { exchangeKey, hashToken } from './redis-keys.js';

/**
 * The hand-off between a redirect and an access token.
 *
 * A magic link and an OAuth callback both end as a `302` to the admin app, and
 * an access token cannot ride in that URL: it would be in browser history, in
 * the `Referer` of the next request, and in every proxy log on the way. So the
 * redirect carries a one-time code instead, and the app posts it to
 * `/api/auth/exchange` to get the token.
 *
 * What is stored is a reference to the refresh family the redirect already set
 * as a cookie, never a token. Sixty seconds is all a browser needs to follow a
 * redirect and make one request.
 */

export const EXCHANGE_TTL_SECONDS = 60;
const CODE_BYTES = 32;

const recordSchema = z.object({
  userId: z.uuid(),
  familyId: z.uuid(),
});

export type ExchangeRecord = z.infer<typeof recordSchema>;

export class ExchangeStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async issue(record: ExchangeRecord): Promise<string> {
    const code = randomBytes(CODE_BYTES).toString('base64url');

    await this.#redis.set(
      exchangeKey(hashToken(code)),
      JSON.stringify(record),
      'EX',
      EXCHANGE_TTL_SECONDS,
    );

    return code;
  }

  async consume(code: string): Promise<ExchangeRecord | null> {
    const raw = await this.#redis.getdel(exchangeKey(hashToken(code)));
    if (raw === null) {
      return null;
    }

    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }
}
