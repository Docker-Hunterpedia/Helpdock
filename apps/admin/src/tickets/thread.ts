import type { TicketActivityEntry, TicketMessage } from '@helpdock/schemas';
import type { PendingMessage } from './pending.js';

/**
 * One thread out of three sources: the messages, the activity log and whatever
 * the composer has sent and not yet heard back about.
 *
 * **Only two activity actions are drawn.** `ticket_activity` is rendered in the
 * thread (`docs/guides/tickets.md`), but three of its five actions are the
 * *same events* as messages — `ticket.created`, `ticket.replied` and
 * `ticket.note_added` each accompany a row that is already a bubble — so
 * drawing them all would say everything twice. What is left is what only the
 * log knows: a field moved, and the status moved.
 *
 * Ordering is by time, and a pending send sorts last within its own instant so
 * that what somebody just typed sits at the bottom where they left it.
 */

const THREAD_EVENT_ACTIONS: readonly string[] = ['ticket.updated', 'ticket.status.changed'];

export type ThreadItem =
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly at: string;
      readonly message: TicketMessage;
    }
  | {
      readonly kind: 'pending';
      readonly id: string;
      readonly at: string;
      readonly message: PendingMessage;
    }
  | {
      readonly kind: 'event';
      readonly id: string;
      readonly at: string;
      readonly entry: TicketActivityEntry;
    };

/** Sorts last within one instant, so an optimistic bubble stays at the end. */
const RANK: Record<ThreadItem['kind'], number> = { event: 0, message: 1, pending: 2 };

export const buildThread = (
  messages: readonly TicketMessage[],
  activity: readonly TicketActivityEntry[],
  pending: readonly PendingMessage[],
): readonly ThreadItem[] => {
  const items: ThreadItem[] = [
    ...messages.map(
      (message): ThreadItem => ({
        kind: 'message',
        id: message.id,
        at: message.createdAt,
        message,
      }),
    ),
    ...activity
      .filter((entry) => THREAD_EVENT_ACTIONS.includes(entry.action))
      .map((entry): ThreadItem => ({ kind: 'event', id: entry.id, at: entry.createdAt, entry })),
    ...pending.map(
      (message): ThreadItem => ({
        kind: 'pending',
        id: message.clientId,
        at: message.createdAt,
        message,
      }),
    ),
  ];

  return items.sort((left, right) => {
    const byTime = left.at.localeCompare(right.at);

    return byTime === 0 ? RANK[left.kind] - RANK[right.kind] : byTime;
  });
};

/** The highest `seq` this client holds, which is what it catches up from (§7). */
export const lastSeq = (messages: readonly TicketMessage[]): number =>
  messages.reduce((highest, message) => Math.max(highest, message.seq), 0);

/**
 * The thread with a page of catch-up applied. A message already held wins over
 * the one that just arrived only in position: both are the same row, and the
 * `seq` ordering is the server's, so it is the one that decides.
 */
export const applyCatchUp = (
  messages: readonly TicketMessage[],
  arrived: readonly TicketMessage[],
): TicketMessage[] => {
  const bySeq = new Map(messages.map((message) => [message.seq, message]));
  for (const message of arrived) {
    bySeq.set(message.seq, message);
  }

  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
};
