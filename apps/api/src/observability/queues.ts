import { createQueueConnection, QUEUE_NAME_LIST, type QueueName } from '@helpdock/jobs';
import type { QueueCounts } from '@helpdock/schemas';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { MILLIS_PER_SECOND } from './time.js';

/**
 * Read-only handles on the twelve queues of ARCHITECTURE §13, for the queue
 * depth metric and the System page. The api never adds a job to them — that is
 * the outbox relay's job and only the relay's (DOMAIN-RULES §6) — so this is
 * `getJobCounts` and nothing else.
 *
 * The connection is its own rather than the `/ready` client's: BullMQ configures
 * a connection the way it needs one, and sharing would mean the queue library's
 * retry policy applying to the readiness probe.
 */

/** BullMQ's states, in the order the System page's table lists them. */
const COUNTED_STATES = ['waiting', 'active', 'failed', 'delayed', 'completed'] as const;

export class QueueRegistry {
  readonly #connection: Redis;
  readonly #queues: ReadonlyMap<QueueName, Queue>;

  constructor(redisUrl: string) {
    this.#connection = createQueueConnection(redisUrl);
    this.#queues = new Map(
      QUEUE_NAME_LIST.map((name) => [name, new Queue(name, { connection: this.#connection })]),
    );
  }

  /**
   * Every queue's depth, in the declared order so the page and the metric agree
   * on what "the first five" means.
   */
  async counts(): Promise<readonly QueueCounts[]> {
    return Promise.all([...this.#queues].map(([name, queue]) => this.#countsOf(name, queue)));
  }

  /**
   * Shutting down must not wait on Redis. A replica is often stopping *because*
   * Redis went away, and `quit()` waits for a reply that will never come — which
   * turns a shutdown into a hang. This registry only ever read, so there is
   * nothing to flush and nothing is lost by dropping the socket.
   */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()].map((queue) => queue.close()));
    this.#connection.disconnect();
  }

  async #countsOf(name: QueueName, queue: Queue): Promise<QueueCounts> {
    const counts = await queue.getJobCounts(...COUNTED_STATES);

    return {
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      oldestWaitingSeconds: await oldestWaitingSeconds(queue),
    };
  }
}

/**
 * How long the head of the queue has been waiting. One job is fetched, not the
 * whole set: the answer is "is anything stuck?", and asking for every waiting
 * job to find out would make a busy queue expensive to look at.
 *
 * BullMQ returns waiting jobs oldest first, so index 0 is the one that has been
 * there longest.
 */
const oldestWaitingSeconds = async (queue: Queue): Promise<number | null> => {
  const [oldest] = await queue.getWaiting(0, 0);
  if (oldest?.timestamp === undefined) {
    return null;
  }

  return Math.max(0, (Date.now() - oldest.timestamp) / MILLIS_PER_SECOND);
};
