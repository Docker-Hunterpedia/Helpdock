import { MARK_IDLE_SCRIPT, STAMP_SCRIPT, TOUCH_SCRIPT } from '../realtime/presence.store.js';
import type { RedisStub } from './redis-stub.js';

/**
 * The JavaScript mirrors of the presence store's Lua, with `clock` standing in
 * for Redis's `TIME`. The scripts themselves, and their atomicity, are proved
 * against a real Redis in `assignment.integration.test.ts`.
 */
export const registerPresenceScripts = (stub: RedisStub, clock: () => number): RedisStub =>
  stub
    .defineScript(TOUCH_SCRIPT, async (s, [members = '', active = '', idle = ''], [user = '']) => {
      if ((await s.sismember(members, user)) === 0) {
        return [0, 0];
      }
      await s.hset(active, user, String(clock()));

      return [1, await s.srem(idle, user)];
    })
    .defineScript(STAMP_SCRIPT, async (s, [members = '', active = ''], [user = '', mode = '']) => {
      if ((await s.sismember(members, user)) === 0) {
        return 0;
      }
      if (mode === 'nx') {
        return s.hsetnx(active, user, String(clock()));
      }
      await s.hset(active, user, String(clock()));

      return 1;
    })
    .defineScript(
      MARK_IDLE_SCRIPT,
      async (s, [members = '', active = '', idle = ''], [user = '', limit = '0']) => {
        if ((await s.sismember(members, user)) === 0) {
          return 0;
        }
        const at = await s.hget(active, user);
        if (at === null) {
          await s.hset(active, user, String(clock()));

          return 0;
        }

        return clock() - Number(at) >= Number(limit) ? s.sadd(idle, user) : 0;
      },
    );
