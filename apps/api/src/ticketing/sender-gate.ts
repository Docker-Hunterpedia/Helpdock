import type { DbTransaction } from '@helpdock/db';
import { type NormaliseOptions, normaliseIdentity } from '@helpdock/schemas';
import { BlockListRepository } from './block-list.repository.js';
import { matchKeysFor, mostSpecific, type SenderKey } from './block-rules.js';

/**
 * The inbound gate of M1-11: "later messages from a blocked sender are dropped
 * before a ticket is created, and counted" (the `Admin/Ticketing › Spam`
 * artboard).
 *
 * **Who calls it.** Every channel that turns a customer's message into a
 * ticket, *before* it creates the contact or the ticket: M2's email poller and
 * inbound-parse endpoint, M4's widget and web form, M6's Telegram bot. A staff
 * member filing a ticket by hand is never gated — the block list is about who
 * may reach the desk, not about whom the desk may write down — so
 * `POST /tickets` does not call it, and M1 has no customer path that does.
 *
 * **What it takes** is the identifier the channel is about to hand
 * `findOrCreateContactByIdentity`, in the same vocabulary and normalised by the
 * same function, so the two can never disagree about who a sender is. A value
 * that does not normalise cannot be on the list and is answered "not blocked";
 * the channel's own contact path refuses it next.
 *
 * **What it writes** is one increment of `dropped_count` on the most specific
 * matching row — the address before its domain, a domain before its parent —
 * in the caller's transaction, so a drop that rolls back is not counted.
 *
 * `tx` is the caller's brand transaction: for a worker, the one opened with
 * `app.brand_ids = {brandId}` as DOMAIN-RULES §1.4 requires. The brand is also
 * named in the query, so a transaction widened to several brands still asks
 * about one.
 */

/** The three identifier kinds a sender arrives with. */
export interface InboundSender {
  readonly kind: 'email' | 'phone' | 'telegram';
  /** As the channel received it. Normalised here. */
  readonly value: string;
}

export type SenderGateResult =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly blockedSenderId: string };

export interface SenderGateOptions extends NormaliseOptions {
  /** When the drop is recorded. Passed in so a job's timestamps agree. */
  readonly now?: Date;
  /** Defaults to a fresh repository; a test passes a double. */
  readonly repository?: BlockListRepository;
}

export const isSenderBlocked = async (
  tx: DbTransaction,
  brandId: string,
  sender: InboundSender,
  {
    now = new Date(),
    repository = new BlockListRepository(),
    ...normalise
  }: SenderGateOptions = {},
): Promise<SenderGateResult> => {
  const normalised = normaliseIdentity(sender.kind, sender.value, normalise);
  if (!normalised.ok) {
    return { blocked: false };
  }

  const keys = matchKeysFor({ kind: sender.kind, value: normalised.value } satisfies SenderKey);
  const match = mostSpecific(keys, await repository.matching(tx, brandId, keys));
  if (match === undefined) {
    return { blocked: false };
  }

  await repository.recordDrop(tx, match.id, now);

  return { blocked: true, blockedSenderId: match.id };
};
