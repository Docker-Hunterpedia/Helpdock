import type { Redis } from 'ioredis';
import { totpUsedStepKey } from '../redis-keys.js';
import { TOTP_EPOCH_TOLERANCE_SECONDS, TOTP_PERIOD_SECONDS } from './totp.js';

/**
 * Remembers the last time step each account's authenticator code was accepted
 * at, so the same code cannot be accepted twice (ASVS 2.8.4, 2.8.5).
 *
 * A spent challenge already stops one code opening one challenge twice; this
 * stops it opening a *second* challenge, or proving a step-up, within the
 * ninety seconds the window of one keeps it valid. Only steps after the last
 * accepted one pass, so an older code that is still inside the window is
 * refused too: once a newer code has been seen, an older one can only come from
 * somebody replaying it.
 *
 * The record lives exactly as long as the newest code it guards can still
 * match, and not a moment longer.
 */

/** A step is valid for its own period plus the tolerance on each side. */
export const USED_STEP_TTL_SECONDS = TOTP_PERIOD_SECONDS + 2 * TOTP_EPOCH_TOLERANCE_SECONDS;

/** Compare and set in one round trip, so two requests racing with one code cannot both win. */
export const CLAIM_STEP_SCRIPT = `
local last = tonumber(redis.call('GET', KEYS[1]) or '-1')
if tonumber(ARGV[1]) <= last then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

export class TotpStepStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** True when this step is newer than any accepted before, and is now recorded as used. */
  async claim(userId: string, timeStep: number): Promise<boolean> {
    const claimed = await this.#redis.eval(
      CLAIM_STEP_SCRIPT,
      1,
      totpUsedStepKey(userId),
      String(timeStep),
      String(USED_STEP_TTL_SECONDS),
    );

    return claimed === 1;
  }
}
