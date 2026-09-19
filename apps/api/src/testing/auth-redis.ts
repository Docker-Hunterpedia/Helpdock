import type { Redis } from 'ioredis';
import { CONSUME_SCRIPT } from '../auth/rate-limit.js';
import { ROTATE_SCRIPT } from '../auth/session/refresh-store.js';
import { RedisStub } from './redis-stub.js';

/**
 * A {@link RedisStub} that knows the two Lua scripts the auth service ships.
 *
 * Each mirror is the same sequence of commands as the Lua beside it, written
 * once here rather than in every test. They are registered by the exact script
 * text the modules export, so changing the Lua without changing the mirror
 * makes the unit suite throw instead of quietly testing the old behaviour —
 * and the Lua itself is exercised against a real Redis in the integration suite.
 */
export const authRedisStub = (): RedisStub =>
  new RedisStub()
    .defineScript(ROTATE_SCRIPT, async (stub, keys, args) => {
      const [familyKey = ''] = keys;
      const [presented, next, lastUsedAt = '', userAgent = '', ttl = '0'] = args;

      const userId = await stub.hget(familyKey, 'userId');
      if (userId === null) {
        return ['unknown', ''];
      }

      if ((await stub.hget(familyKey, 'currentHash')) !== presented) {
        await stub.del(familyKey);
        return ['reused', userId];
      }

      await stub.hset(familyKey, {
        currentHash: String(next),
        lastUsedAt,
        ua: userAgent,
      });
      await stub.expire(familyKey, Number(ttl));

      return ['rotated', userId];
    })
    .defineScript(CONSUME_SCRIPT, async (stub, keys, args) => {
      const [counterKey = ''] = keys;
      const [cutoff = '0', now = '0', limit = '0', windowMs = '0', member = ''] = args;

      await stub.zremrangebyscore(counterKey, 0, Number(cutoff));
      if ((await stub.zcard(counterKey)) >= Number(limit)) {
        await stub.pexpire(counterKey, Number(windowMs));
        return 0;
      }

      await stub.zadd(counterKey, Number(now), member);
      await stub.pexpire(counterKey, Number(windowMs));

      return 1;
    });

/** The same stub, typed as the client the services take. */
export const authRedis = (): { stub: RedisStub; redis: Redis } => {
  const stub = authRedisStub();
  return { stub, redis: stub.asRedis() };
};
