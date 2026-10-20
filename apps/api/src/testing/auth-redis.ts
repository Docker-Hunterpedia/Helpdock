import type { Redis } from 'ioredis';
import {
  CONSUME_SCRIPT,
  REFUND_SIGN_IN_SCRIPT,
  RESERVE_SIGN_IN_SCRIPT,
} from '../auth/rate-limit.js';
import { REGISTER_SESSION_SCRIPT, ROTATE_SCRIPT } from '../auth/session/refresh-store.js';
import { CLAIM_STEP_SCRIPT } from '../auth/totp/used-steps.js';
import { RedisStub } from './redis-stub.js';

/**
 * A {@link RedisStub} that knows the Lua scripts the auth service ships.
 *
 * Each mirror is the same sequence of commands as the Lua beside it, written
 * once here rather than in every test. They are registered by the exact script
 * text the modules export, so changing the Lua without changing the mirror
 * makes the unit suite throw instead of quietly testing the old behaviour —
 * and the Lua itself is exercised against a real Redis in the integration suite.
 */
export const authRedisStub = (): RedisStub =>
  new RedisStub()
    .defineScript(REGISTER_SESSION_SCRIPT, async (stub, keys, args) => {
      const [family = '', sessions = '', revoked = ''] = keys;
      const [ttl = '0', session = ''] = args;
      if (!(await stub.exists(family))) {
        await stub.set(revoked, '1', 'EX', Number(ttl));
        return 0;
      }
      await stub.sadd(sessions, session);
      await stub.expire(sessions, Number(ttl));
      return 1;
    })
    .defineScript(ROTATE_SCRIPT, async (stub, keys, args) => {
      const [familyKey = ''] = keys;
      const [presented, next, now = '0', userAgent = '', idle = '0', max = '0'] = args;

      const userId = await stub.hget(familyKey, 'userId');
      if (userId === null) {
        return ['unknown', ''];
      }

      if ((await stub.hget(familyKey, 'currentHash')) !== presented) {
        await stub.del(familyKey);
        return ['reused', userId];
      }

      const issuedAt = Number((await stub.hget(familyKey, 'issuedAt')) ?? '0');
      const maximum = Math.min(
        Number((await stub.hget(familyKey, 'maxSeconds')) ?? max),
        Number(max),
      );
      const remaining = issuedAt + maximum - Number(now);
      if (remaining <= 0) {
        await stub.del(familyKey);
        return ['expired', userId];
      }

      await stub.hset(familyKey, {
        currentHash: String(next),
        lastUsedAt: now,
        ua: userAgent,
      });
      await stub.expire(familyKey, Math.min(Number(idle), remaining));

      return ['rotated', userId];
    })
    .defineScript(RESERVE_SIGN_IN_SCRIPT, async (stub, keys, args) => {
      const now = Number(args[0]);
      const windowMs = Number(args[1]);
      let retry = 0;
      const blocked = [0, 0];
      for (const [index, key] of keys.entries()) {
        await stub.zremrangebyscore(key, '-Infinity', now - windowMs);
        if ((await stub.zcard(key)) >= Number(args[index + 2])) {
          blocked[index] = 1;
          const oldest = await stub.zrange(key, 0, 0, 'WITHSCORES');
          retry = Math.max(retry, Number(oldest[1]) + windowMs);
        }
      }
      if (retry > 0) return [retry, ...blocked];
      for (const key of keys) {
        await stub.zadd(key, now, args[4] ?? '');
        await stub.pexpire(key, windowMs);
      }
      return [0, 0, 0];
    })
    .defineScript(REFUND_SIGN_IN_SCRIPT, async (stub, keys, args) => {
      for (const key of keys) await stub.zrem(key, args[0] ?? '');
      return 0;
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
    })
    .defineScript(CLAIM_STEP_SCRIPT, async (stub, keys, args) => {
      const [stepKey = ''] = keys;
      const [step = '0', ttl = '0'] = args;

      if (Number(step) <= Number((await stub.get(stepKey)) ?? '-1')) {
        return 0;
      }
      await stub.set(stepKey, step, 'EX', Number(ttl));

      return 1;
    });

/** The same stub, typed as the client the services take. */
export const authRedis = (): { stub: RedisStub; redis: Redis } => {
  const stub = authRedisStub();
  return { stub, redis: stub.asRedis() };
};
