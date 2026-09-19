import {
  PRESENCE_SOCKET_TTL_SECONDS,
  type PresenceMap,
  type PresenceStatus,
  type SettablePresenceStatus,
} from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { derivePresence, presenceMapOf } from './presence-status.js';

/**
 * Where presence lives: Redis, because it is derived from sockets spread over
 * every api replica and no replica can answer for the others (DOMAIN-RULES
 * §12).
 *
 * Four keys, and a reason for each:
 *
 * | Key | Holds | Expiry |
 * |---|---|---|
 * | `presence:brands` | brands with anyone present, so the reaper has something to walk | with its last member |
 * | `presence:<brandId>` | user ids present in that brand | with its last member |
 * | `presence:sockets:<brandId>:<userId>` | that person's socket ids there | with its last member |
 * | `presence:sock:<socketId>` | nothing; its existence *is* the liveness | 60 s, refreshed by the client |
 * | `presence:status:<brandId>` | the explicit `away` toggles, per user | with its last member |
 *
 * The liveness key is the only one with a TTL, and that is deliberate: a
 * replica that dies without running a single `disconnect` handler leaves its
 * sockets' keys behind, they expire within a minute, and the reaper turns the
 * people they belonged to offline. Nothing else has to notice the crash.
 */

export const presenceBrandsKey = 'presence:brands';
export const presenceBrandKey = (brandId: string): string => `presence:${brandId}`;
export const presenceSocketsKey = (brandId: string, userId: string): string =>
  `presence:sockets:${brandId}:${userId}`;
export const presenceSocketKey = (socketId: string): string => `presence:sock:${socketId}`;
export const presenceStatusKey = (brandId: string): string => `presence:status:${brandId}`;

/**
 * Whether the command at `index` added a set member. A failed command reports
 * its error in slot 0, and reading slot 1 regardless would make a failure look
 * like "was already there" — which is the one answer that suppresses an event.
 */
const added = (results: [Error | null, unknown][] | null, index: number): boolean => {
  const result = results?.[index];
  return result !== undefined && result[0] === null && result[1] === 1;
};

export interface PresenceMembership {
  readonly brandId: string;
  readonly userId: string;
  readonly socketId: string;
}

export class PresenceStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /**
   * Records one socket as present. Answers whether this made the person newly
   * present in the brand, which is what decides whether an event is emitted:
   * a second tab must not announce an arrival.
   */
  async join({ brandId, userId, socketId }: PresenceMembership): Promise<{ arrived: boolean }> {
    const results = await this.#redis
      .multi()
      .sadd(presenceBrandsKey, brandId)
      .sadd(presenceBrandKey(brandId), userId)
      .sadd(presenceSocketsKey(brandId, userId), socketId)
      .set(presenceSocketKey(socketId), '1', 'EX', PRESENCE_SOCKET_TTL_SECONDS)
      .exec();

    // `sadd` answers 1 only when the member was not already there. Index 1 is
    // the brand's member set, in the order the pipeline above queues them.
    return { arrived: added(results, 1) };
  }

  /**
   * Refreshes the liveness key and repairs the sets behind it. Repairing rather
   * than only refreshing matters because a reaper on another replica may have
   * removed this person a moment before the heartbeat arrived; without the
   * re-add they would stay missing until they reconnected.
   */
  async heartbeat(
    socketId: string,
    memberships: readonly PresenceMembership[],
  ): Promise<{ readonly repaired: readonly PresenceMembership[] }> {
    const pipeline = this.#redis.multi();
    pipeline.set(presenceSocketKey(socketId), '1', 'EX', PRESENCE_SOCKET_TTL_SECONDS);

    // Where each membership's re-add lands, recorded as the commands are queued
    // rather than computed from a stride, so adding one cannot silently turn
    // "repaired" into a reading of the wrong result.
    const brandSetAt = new Map<PresenceMembership, number>();
    let queued = 1;
    for (const membership of memberships) {
      pipeline.sadd(presenceBrandsKey, membership.brandId);
      queued += 1;
      brandSetAt.set(membership, queued);
      pipeline.sadd(presenceBrandKey(membership.brandId), membership.userId);
      pipeline.sadd(presenceSocketsKey(membership.brandId, membership.userId), membership.socketId);
      queued += 2;
    }

    const results = await pipeline.exec();
    const repaired = memberships.filter((membership) =>
      added(results, brandSetAt.get(membership) ?? -1),
    );

    return { repaired };
  }

  /**
   * Forgets one socket. Answers whether that was the person's last socket in
   * the brand, in which case they have gone offline.
   */
  async leave({ brandId, userId, socketId }: PresenceMembership): Promise<{ departed: boolean }> {
    await this.#redis.srem(presenceSocketsKey(brandId, userId), socketId);
    await this.#redis.del(presenceSocketKey(socketId));

    const remaining = await this.#redis.scard(presenceSocketsKey(brandId, userId));
    if (remaining > 0) {
      return { departed: false };
    }

    return { departed: await this.#forget(brandId, userId) };
  }

  /** The explicit toggle. Ignored for someone with no socket: they are offline. */
  async setStatus(
    { brandId, userId }: Omit<PresenceMembership, 'socketId'>,
    status: SettablePresenceStatus,
  ): Promise<boolean> {
    if ((await this.#redis.sismember(presenceBrandKey(brandId), userId)) !== 1) {
      return false;
    }

    if (status === 'online') {
      // Absence of a toggle *is* online, so clearing it keeps the hash the size
      // of the people who are away rather than the size of the brand.
      await this.#redis.hdel(presenceStatusKey(brandId), userId);
    } else {
      await this.#redis.hset(presenceStatusKey(brandId), userId, status);
    }

    return true;
  }

  /** One person's status, without reading the whole brand to find it. */
  async statusOf(brandId: string, userId: string): Promise<PresenceStatus> {
    const [present, explicit] = await Promise.all([
      this.#redis.sismember(presenceBrandKey(brandId), userId),
      this.#redis.hget(presenceStatusKey(brandId), userId),
    ]);

    return derivePresence({
      hasLiveSocket: present === 1,
      explicit: explicit === 'away' ? 'away' : undefined,
    });
  }

  async map(brandId: string): Promise<PresenceMap> {
    const [present, explicit] = await Promise.all([
      this.#redis.smembers(presenceBrandKey(brandId)),
      this.#redis.hgetall(presenceStatusKey(brandId)),
    ]);

    return presenceMapOf(present, explicit);
  }

  /** Every brand anyone is present in. The reaper's work list. */
  async brands(): Promise<readonly string[]> {
    return this.#redis.smembers(presenceBrandsKey);
  }

  /**
   * Drops the sockets of `userId` in `brandId` whose liveness key has expired,
   * and answers whether that left them with none.
   *
   * The removal from the brand's member set is what decides who announces the
   * change: every replica sweeps, but `srem` answers 1 on exactly one of them,
   * so `presence:changed` is emitted once however many replicas are running.
   */
  async sweepUser(brandId: string, userId: string): Promise<{ departed: boolean }> {
    const socketIds = await this.#redis.smembers(presenceSocketsKey(brandId, userId));
    if (socketIds.length === 0) {
      return { departed: await this.#forget(brandId, userId) };
    }

    // `mget` in one round trip rather than an `exists` per socket: a brand with
    // a hundred agents would otherwise cost a hundred calls every thirty
    // seconds on every replica.
    const alive = await this.#redis.mget(socketIds.map(presenceSocketKey));
    const dead = socketIds.filter((_, index) => alive[index] === null);
    if (dead.length > 0) {
      await this.#redis.srem(presenceSocketsKey(brandId, userId), ...dead);
    }
    if (dead.length < socketIds.length) {
      return { departed: false };
    }

    return { departed: await this.#forget(brandId, userId) };
  }

  async usersIn(brandId: string): Promise<readonly string[]> {
    return this.#redis.smembers(presenceBrandKey(brandId));
  }

  /**
   * Takes a person out of a brand's presence. The `srem` result is the claim:
   * only the caller that removed them may announce it.
   */
  async #forget(brandId: string, userId: string): Promise<boolean> {
    const removed = await this.#redis.srem(presenceBrandKey(brandId), userId);
    await this.#redis.hdel(presenceStatusKey(brandId), userId);

    if ((await this.#redis.scard(presenceBrandKey(brandId))) === 0) {
      await this.#redis.srem(presenceBrandsKey, brandId);
    }

    return removed === 1;
  }
}
