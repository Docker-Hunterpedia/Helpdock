import { META_PACE_MS } from '@helpdock/schemas';
import type { Redis } from 'ioredis';

/**
 * WhatsApp refuses more than one message every six seconds to one user
 * (`131056`, the pair limit), so a reply of several parts, or two replies to the
 * same customer, must be spaced (ADR 0025, 7). The pace is one Redis key per
 * account and customer, `SET key 1 NX PX 6000`: the part that wins it is sent,
 * and the key then stands for six seconds from the end of that send.
 *
 * A part that loses it is not slept on. The send job moves itself to delayed
 * for the remainder and ends with BullMQ's `DelayedError`, which costs no
 * attempt and frees the worker, instead of holding a concurrency slot for six
 * seconds a part (`meta-send.job.ts`). This module only decides whether it is
 * this part's turn, and says how long to wait when it is not.
 *
 * Messenger and Instagram have no such limit and are not paced.
 */

export const paceKey = (accountId: string, customerId: string): string =>
  `meta.pace:${accountId}:${customerId}`;

/** Added to the remainder so the next try does not land a millisecond before the key goes. */
const PACE_SLACK_MS = 50;

/** It is not this part's turn: another message to the customer went out `remainingMs` ago less than a pace. */
export class RecipientPaceHeld extends Error {
  readonly remainingMs: number;

  constructor(remainingMs: number) {
    super(`Another message to this customer went out a moment ago; wait ${String(remainingMs)} ms`);
    this.name = 'RecipientPaceHeld';
    this.remainingMs = remainingMs;
  }
}

const remainingOf = async (redis: Redis, key: string, paceMs: number): Promise<number> => {
  const left = await redis.pttl(key);
  // -2: the key went between the claim and this read, so the slot is free.
  // -1: it has no expiry, which this module never writes; wait a whole pace.
  if (left === -2) {
    return PACE_SLACK_MS;
  }
  return (left === -1 ? paceMs : left) + PACE_SLACK_MS;
};

/**
 * Runs `send` if this customer's slot is free, and keeps the slot for a pace
 * after it ends. Throws {@link RecipientPaceHeld} without running it when the
 * slot is held. A send that throws leaves the claim as it was made, so a retry
 * a moment later waits out the rest of the pace, the safe side of a limit Meta
 * counts on its own side.
 */
export const withRecipientPace = async <T>(
  redis: Redis,
  key: string,
  send: () => Promise<T>,
  paceMs: number = META_PACE_MS,
): Promise<T> => {
  const claimed = await redis.set(key, '1', 'PX', paceMs, 'NX');
  if (claimed !== 'OK') {
    throw new RecipientPaceHeld(await remainingOf(redis, key, paceMs));
  }

  const result = await send();
  // Meta measures the gap between messages it received, not between our calls.
  await redis.set(key, '1', 'PX', paceMs);

  return result;
};

/**
 * Meta said `131056` for this customer: whoever else is about to send to them
 * waits a pace, even if no part of ours held the slot.
 */
export const holdRecipientPace = async (
  redis: Redis,
  key: string,
  paceMs: number = META_PACE_MS,
): Promise<void> => {
  await redis.set(key, '1', 'PX', paceMs);
};
