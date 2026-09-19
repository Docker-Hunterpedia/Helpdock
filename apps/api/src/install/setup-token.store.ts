import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { hashToken } from '../auth/redis-keys.js';

/**
 * The thread that holds the four wizard steps together.
 *
 * Step 1 creates the install admin, which is the moment the install stops being
 * `fresh` — so steps 2 to 4 cannot be authorised by "nobody has set this up
 * yet" any more. They are authorised by this token instead: issued once, to the
 * browser that created the admin, valid for half an hour, and consumed when the
 * wizard finishes.
 *
 * It is not a session. It authorises exactly the remaining setup calls, it
 * carries no claims, and `@Requires` never sees it. The session the admin ends
 * up signed in with is an ordinary one, opened when the first brand exists
 * (before that there is no brand for a session to land in, so `SessionService`
 * correctly refuses to open one).
 *
 * As everywhere else in the api, Redis holds the SHA-256 of the token and never
 * the token: `KEYS setup:*` on a compromised Redis yields nothing presentable.
 */

/** Long enough to read the master-key note and find the SMTP password. */
export const SETUP_TOKEN_TTL_SECONDS = 30 * 60;

const TOKEN_BYTES = 32;

const setupKey = (tokenHash: string): string => `setup:wizard:${tokenHash}`;

const recordSchema = z.object({
  userId: z.uuid(),
  email: z.email(),
  /** Set by step 2, so step 3 knows which brand the summary names. */
  brandId: z.uuid().nullable(),
});

export type SetupRecord = z.infer<typeof recordSchema>;

export interface IssuedSetupToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

export class SetupTokenStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async issue(record: SetupRecord): Promise<IssuedSetupToken> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await this.#redis.set(
      setupKey(hashToken(token)),
      JSON.stringify(record),
      'EX',
      SETUP_TOKEN_TTL_SECONDS,
    );

    return { token, expiresInSeconds: SETUP_TOKEN_TTL_SECONDS };
  }

  /** The record behind a token, or null for one that never existed or has expired. */
  async read(token: string | undefined): Promise<SetupRecord | null> {
    if (token === undefined || token === '') {
      return null;
    }

    return this.#parse(await this.#redis.get(setupKey(hashToken(token))));
  }

  /**
   * Rewrites the record without extending its life: the half hour runs from
   * step 1, so a wizard left open overnight expires whatever it was doing.
   */
  async update(token: string, record: SetupRecord): Promise<void> {
    await this.#redis.set(setupKey(hashToken(token)), JSON.stringify(record), 'KEEPTTL');
  }

  /** Reads and deletes in one round trip, so a replayed finish finds nothing. */
  async consume(token: string | undefined): Promise<SetupRecord | null> {
    if (token === undefined || token === '') {
      return null;
    }

    return this.#parse(await this.#redis.getdel(setupKey(hashToken(token))));
  }

  #parse(raw: string | null): SetupRecord | null {
    if (raw === null) {
      return null;
    }

    try {
      const parsed = recordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      // A record this process cannot read is a record it must not honour.
      return null;
    }
  }
}
