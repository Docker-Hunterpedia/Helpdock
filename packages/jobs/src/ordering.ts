import type { DbTransaction } from '@helpdock/db';
import { sql } from 'drizzle-orm';

/**
 * Per-ticket order for `outbox.event` while different tickets run at once.
 *
 * The consumer used to take one event at a time, which kept every event in
 * relay order and capped the whole install at one handler's speed: five agent
 * replies a second backed the queue up into seconds (docs/guides/performance.md).
 * The handlers do not need a global order. What they assume is that two events
 * *of one ticket* never run at once and run in the order they were written:
 * the widget relay sends a ticket's frames in `seq` order, the SLA handler
 * re-plans one ticket's timers from its clocks, the rules handler evaluates one
 * ticket's changes in turn. Events of different tickets share nothing a
 * handler does not already lock for itself (assignment takes a brand-level
 * advisory lock; merges lock both tickets' rows).
 *
 * So an event is given **ordering keys** — every ticket it names, or its brand
 * when it names none — and two layers keep events that share a key apart:
 *
 * 1. **In the process**, {@link createKeyedSerializer} chains each event behind
 *    the last one that shares a key, in the order BullMQ hands them over,
 *    which is the order the relay published them in. That is the order.
 * 2. **Across replicas**, {@link lockOrderingKeys} takes a transaction-level
 *    advisory lock per key before any handler runs, so two worker processes
 *    never run events of one ticket at the same moment. Replicas consume one
 *    queue, so between them the order is BullMQ's fetch order, as it always was.
 *
 * Not ordered, as before: a retried event, which goes back with a delay while
 * its successors run. Every handler reads the ticket's current state rather
 * than trusting the event's, which is what makes a late retry harmless.
 */

/** Any top-level field ending in `ticketId` names a ticket; one ending in `ticketIds`, several. */
const TICKET_ID_FIELD = /ticketId$/i;
const TICKET_IDS_FIELD = /ticketIds$/i;

const brandKey = (brandId: string): string => `brand:${brandId}`;
const ticketKey = (ticketId: string): string => `ticket:${ticketId}`;

/**
 * The keys an event is ordered by: every ticket its payload names, sorted and
 * without repeats, or the brand when it names none. Events that are about no
 * ticket in particular (a mailbox changed, an article was published) keep the
 * order among themselves they always had.
 */
export const outboxOrderingKeys = ({
  brandId,
  payload,
}: {
  readonly brandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): readonly string[] => {
  const ticketIds = new Set<string>();

  for (const [field, value] of Object.entries(payload)) {
    if (TICKET_ID_FIELD.test(field) && typeof value === 'string') {
      ticketIds.add(value);
    } else if (TICKET_IDS_FIELD.test(field) && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          ticketIds.add(item);
        }
      }
    }
  }

  return ticketIds.size === 0 ? [brandKey(brandId)] : [...ticketIds].sort().map(ticketKey);
};

export interface KeyedSerializer {
  /**
   * Runs `task` once every task registered earlier under any of `keys` has
   * settled. Registration happens synchronously, in call order, which is what
   * makes call order the execution order for each key.
   */
  run<T>(keys: readonly string[], task: () => Promise<T>): Promise<T>;
  /** Keys with a task registered or running. For tests and for nothing else. */
  readonly pending: number;
}

export const createKeyedSerializer = (): KeyedSerializer => {
  const tails = new Map<string, Promise<void>>();

  return {
    run: <T>(keys: readonly string[], task: () => Promise<T>): Promise<T> => {
      const unique = [...new Set(keys)];
      const before = unique.map((key) => tails.get(key));

      let release: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (const key of unique) {
        tails.set(key, done);
      }

      const settle = (): void => {
        release();
        for (const key of unique) {
          // A later task may already have queued behind this one; its tail stays.
          if (tails.get(key) === done) {
            tails.delete(key);
          }
        }
      };

      // A predecessor that failed has still finished; its failure is its own job's.
      const result = Promise.allSettled(before).then(task);
      result.then(settle, settle);

      return result;
    },
    get pending() {
      return tails.size;
    },
  };
};

/**
 * One transaction-level advisory lock per key, in sorted order so two events
 * that share several tickets cannot deadlock. Taken before any handler runs and
 * released by the commit or the rollback. The namespace keeps these locks apart
 * from every other advisory lock in the schema.
 */
export const lockOrderingKeys = async (
  tx: DbTransaction,
  keys: readonly string[],
): Promise<void> => {
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`helpdock:outbox:${key}`}, 0))`,
    );
  }
};
