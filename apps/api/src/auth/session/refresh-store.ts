import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@helpdock/db';
import type { Redis } from 'ioredis';
import {
  familyKey,
  familySessionsKey,
  hashToken,
  revokedSessionKey,
  userFamiliesKey,
} from '../redis-keys.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.js';

/**
 * Refresh tokens, as ARCHITECTURE §7 specifies them: opaque, rotating, thirty
 * days, and held in Redis so they can be revoked.
 *
 * A **family** is one browser's chain of tokens. Every refresh mints a new
 * token and forgets the old one, so a token is worth exactly one use. If a
 * token that has already been rotated is presented, two parties hold the same
 * chain and one of them stole it; there is no way to tell which, so the whole
 * family dies. That is the standard answer, and it is why rotation without
 * reuse detection is not worth much.
 *
 * Only the SHA-256 of the current token is stored. A dump of Redis therefore
 * contains no usable session.
 */

/** Thirty days, in seconds (ARCHITECTURE §7). */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const TOKEN_BYTES = 32;
/** Enough to tell two browsers apart in an operator's eyes; not a fingerprint. */
const MAX_USER_AGENT_LENGTH = 120;

export type RotationOutcome =
  | { readonly status: 'rotated'; readonly userId: string; readonly token: string }
  /** The presented token is not the family's current one: someone has a copy. */
  | { readonly status: 'reused'; readonly userId: string }
  /** No such family: it expired, or it was revoked, or the cookie is made up. */
  | { readonly status: 'unknown' };

export interface IssuedRefreshToken {
  readonly familyId: string;
  readonly token: string;
}

/** One browser, as {@link RefreshStore.familiesOf} reports it. Seconds, not milliseconds. */
export interface RefreshFamily {
  readonly familyId: string;
  readonly issuedAt: number;
  readonly lastUsedAt: number;
  /** Already truncated to {@link MAX_USER_AGENT_LENGTH}; empty when none was sent. */
  readonly userAgent: string;
}

/**
 * Compare-and-set in one round trip. Two refreshes racing on the same token
 * would otherwise both read the current hash, both match it, and both succeed —
 * which is exactly the state reuse detection exists to notice.
 *
 * The hash comparison is not constant time. It does not need to be: the stored
 * value is the hash of a 256-bit random token, so learning it byte by byte
 * would still leave an attacker unable to produce the preimage the api asks for.
 */
export const ROTATE_SCRIPT = `
local userId = redis.call('HGET', KEYS[1], 'userId')
if not userId then
  return {'unknown', ''}
end
if redis.call('HGET', KEYS[1], 'currentHash') ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {'reused', userId}
end
redis.call('HSET', KEYS[1], 'currentHash', ARGV[2], 'lastUsedAt', ARGV[3], 'ua', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return {'rotated', userId}
`;

const newToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

export const truncateUserAgent = (userAgent: string | undefined): string =>
  (userAgent ?? '').slice(0, MAX_USER_AGENT_LENGTH);

/**
 * A stored epoch-seconds field, or `null` when Redis had nothing there.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so the missing field
 * has to be recognised before it is coerced. Getting this wrong turns a family
 * whose record has expired into a browser that has been signed in since 1970.
 */
const toSeconds = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
};

export class RefreshStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** Opens a new family for a browser that has just proved who it is. */
  async createFamily({
    userId,
    userAgent,
  }: {
    readonly userId: string;
    readonly userAgent: string | undefined;
  }): Promise<IssuedRefreshToken> {
    const familyId = uuidv7();
    const token = newToken();
    const now = Math.floor(Date.now() / 1000);

    await this.#redis
      .multi()
      .hset(familyKey(familyId), {
        userId,
        currentHash: hashToken(token),
        issuedAt: String(now),
        lastUsedAt: String(now),
        ua: truncateUserAgent(userAgent),
      })
      .expire(familyKey(familyId), REFRESH_TOKEN_TTL_SECONDS)
      .sadd(userFamiliesKey(userId), familyId)
      .expire(userFamiliesKey(userId), REFRESH_TOKEN_TTL_SECONDS)
      .exec();

    return { familyId, token };
  }

  /**
   * Spends the presented token and mints the next one, or reports that the
   * family has to die. Revoking on reuse is the caller's to do, so that
   * publishing `principal.revoked` happens in one place.
   */
  async rotate({
    familyId,
    token,
    userAgent,
  }: {
    readonly familyId: string;
    readonly token: string;
    readonly userAgent: string | undefined;
  }): Promise<RotationOutcome> {
    const next = newToken();
    const now = Math.floor(Date.now() / 1000);

    const [status, userId] = (await this.#redis.eval(
      ROTATE_SCRIPT,
      1,
      familyKey(familyId),
      hashToken(token),
      hashToken(next),
      String(now),
      truncateUserAgent(userAgent),
      String(REFRESH_TOKEN_TTL_SECONDS),
    )) as [string, string];

    if (status === 'rotated') {
      await this.#redis.expire(userFamiliesKey(userId), REFRESH_TOKEN_TTL_SECONDS);
      return { status: 'rotated', userId, token: next };
    }
    if (status === 'reused') {
      // The family is already gone; what is left is the bookkeeping around it,
      // and marking the access tokens it issued so the theft ends now and not
      // in ten minutes.
      await this.#forgetFamily(userId, familyId);
      return { status: 'reused', userId };
    }

    return { status: 'unknown' };
  }

  /**
   * Remembers that this family issued this access token, so revoking the family
   * can reach a token that is already in a browser. Only the last ten minutes
   * are kept, because that is the longest an access token can still be valid.
   */
  async registerSession(familyId: string, sessionId: string): Promise<void> {
    await this.#redis
      .multi()
      .sadd(familySessionsKey(familyId), sessionId)
      .expire(familySessionsKey(familyId), ACCESS_TOKEN_TTL_SECONDS)
      .exec();
  }

  /**
   * Every family this user still holds, newest first. The security page lists
   * them as browsers, and the staff table derives "last active" from the newest
   * `lastUsedAt` among them (M0-06).
   *
   * A family id in the index whose record has expired is dropped from the index
   * on the way past, so the set does not accumulate ids Redis has already
   * forgotten.
   */
  async familiesOf(userId: string): Promise<RefreshFamily[]> {
    const familyIds = await this.#redis.smembers(userFamiliesKey(userId));
    if (familyIds.length === 0) {
      return [];
    }

    const pipeline = this.#redis.multi();
    for (const familyId of familyIds) {
      pipeline.hmget(familyKey(familyId), 'issuedAt', 'lastUsedAt', 'ua');
    }
    const results = (await pipeline.exec()) ?? [];

    const families: RefreshFamily[] = [];
    const stale: string[] = [];

    for (const [index, familyId] of familyIds.entries()) {
      const fields = results[index]?.[1] as (string | null)[] | undefined;
      // The absent field has to be tested before it is coerced: `Number(null)`
      // is 0, and 0 is finite, so a family whose hash has expired would
      // otherwise be reported as a live browser signed in at the epoch.
      const issuedAt = toSeconds(fields?.[0]);
      const lastUsedAt = toSeconds(fields?.[1]);

      if (issuedAt === null || lastUsedAt === null) {
        stale.push(familyId);
        continue;
      }

      families.push({ familyId, issuedAt, lastUsedAt, userAgent: fields?.[2] ?? '' });
    }

    if (stale.length > 0) {
      await this.#redis.srem(userFamiliesKey(userId), ...stale);
    }

    return families.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /**
   * The newest `lastUsedAt` of each user, in two round trips however many users
   * are asked about. The staff table shows "Last active" for everybody at once,
   * and walking {@link familiesOf} per row would be a round trip per person.
   *
   * Users with no live family are absent from the map rather than zero, so the
   * caller can tell "never signed in" from "signed in at the epoch".
   */
  async lastActiveOf(userIds: readonly string[]): Promise<Map<string, number>> {
    const lastActive = new Map<string, number>();
    if (userIds.length === 0) {
      return lastActive;
    }

    const families = this.#redis.multi();
    for (const userId of userIds) {
      families.smembers(userFamiliesKey(userId));
    }
    const familyResults = (await families.exec()) ?? [];

    const owners: string[] = [];
    const timestamps = this.#redis.multi();
    for (const [index, userId] of userIds.entries()) {
      for (const familyId of (familyResults[index]?.[1] as string[] | undefined) ?? []) {
        owners.push(userId);
        timestamps.hget(familyKey(familyId), 'lastUsedAt');
      }
    }

    if (owners.length === 0) {
      return lastActive;
    }

    const timestampResults = (await timestamps.exec()) ?? [];
    for (const [index, userId] of owners.entries()) {
      const seconds = toSeconds(timestampResults[index]?.[1] as string | null | undefined);
      if (seconds !== null) {
        lastActive.set(userId, Math.max(lastActive.get(userId) ?? 0, seconds));
      }
    }

    return lastActive;
  }

  /** The user the family belongs to, or `null` when there is no such family. */
  async userOfFamily(familyId: string): Promise<string | null> {
    return this.#redis.hget(familyKey(familyId), 'userId');
  }

  /**
   * Ends one family: its refresh token stops working immediately, and every
   * access token it issued in the last ten minutes is marked revoked so the
   * resolver refuses it on the next request.
   */
  async revokeFamily(familyId: string): Promise<string | null> {
    const userId = await this.userOfFamily(familyId);
    await this.#redis.del(familyKey(familyId));
    await this.#forgetFamily(userId, familyId);

    return userId;
  }

  /** "Log out everywhere", and what a password reset or a role change triggers. */
  async revokeAllForUser(userId: string): Promise<number> {
    const familyIds = await this.#redis.smembers(userFamiliesKey(userId));
    for (const familyId of familyIds) {
      await this.revokeFamily(familyId);
    }
    await this.#redis.del(userFamiliesKey(userId));

    return familyIds.length;
  }

  /**
   * The one lookup a request makes on the hot path. Everything else the guard
   * needs is in the token's claims.
   */
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    return (await this.#redis.exists(revokedSessionKey(sessionId))) === 1;
  }

  /**
   * Everything that has to happen once a family's own record is gone: mark the
   * access tokens it issued, drop the index of them, and take it off the user's
   * list. The marker expires with the tokens it is about, so the set of revoked
   * session ids can never grow without bound.
   */
  async #forgetFamily(userId: string | null, familyId: string): Promise<void> {
    const sessionIds = await this.#redis.smembers(familySessionsKey(familyId));

    const pipeline = this.#redis.multi();
    for (const sessionId of sessionIds) {
      pipeline.set(revokedSessionKey(sessionId), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS);
    }
    pipeline.del(familySessionsKey(familyId));
    if (userId !== null && userId !== '') {
      pipeline.srem(userFamiliesKey(userId), familyId);
    }
    await pipeline.exec();
  }
}
