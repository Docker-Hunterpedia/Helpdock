import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import {
  createOutboxEventHandler,
  createQueueConnection,
  createWorker,
  type JobLogger,
  type OutboxRelay,
  outboxEventJob,
  type RelayStatusStore,
  startOutboxRelay,
} from '@helpdock/jobs';
import type { Redis } from 'ioredis';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { registerTicketEventHandlers } from '../tickets/ticket-events.js';

/**
 * What `APP_ROLE=worker` runs, in the order and with the shutdown order
 * `packages/jobs/README.md` specifies.
 *
 * 1. Handlers are registered before the worker starts. `settings.changed` ships
 *    registered by `@helpdock/jobs` itself; M1's four ticket events are
 *    registered here. A milestone that consumes a new event does the same,
 *    before the worker is created, because a job that arrives before its handler
 *    fails as an unknown event and burns attempts.
 * 2. The `outbox.event` consumer, which claims a receipt before the handler runs.
 * 3. The relay, which publishes committed outbox rows to BullMQ.
 *
 * Shutting down goes the other way: the relay stops adding jobs, then the
 * worker drains what it has, then the connection closes. Closing the connection
 * first would leave an in-flight job with no Redis to report to.
 */

export interface Closable {
  close(): Promise<void>;
}

/** The four things this module does. Boot passes BullMQ; a test passes doubles. */
export interface WorkerDependencies {
  createConnection(url: string): Redis;
  /**
   * Registers this milestone's outbox handlers. It is a dependency rather than
   * a plain call because the dispatcher is a process-wide registry that refuses
   * a second registration of the same event — which is what a test starting
   * several workers in one process would do.
   */
  registerHandlers(redis: Redis): void;
  createEventWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
  startRelay(options: {
    db: Db;
    redis: Redis;
    log: JobLogger;
    listenUrl: string;
    status: RelayStatusStore;
  }): OutboxRelay;
}

export const workerDependencies: WorkerDependencies = {
  createConnection: (url) => createQueueConnection(url),
  // The broadcast publishes on the same connection: a ticket event ends in a
  // socket frame, and only an `APP_ROLE=api` replica holds sockets
  // (`realtime/broadcast.ts`).
  registerHandlers: (redis) => registerTicketEventHandlers(new RedisRealtimeBroadcast(redis)),
  createEventWorker: ({ redis, db, log }) =>
    createWorker(outboxEventJob, createOutboxEventHandler(), { redis, db, log }),
  startRelay: ({ db, redis, log, listenUrl, status }) =>
    startOutboxRelay({ db, redis, log, listenUrl, status }),
};

export interface StartWorkerOptions {
  readonly env: Pick<Env, 'REDIS_URL' | 'DATABASE_URL'>;
  readonly db: Db;
  readonly log: JobLogger;
  readonly deps?: WorkerDependencies;
}

export const startWorker = ({
  env,
  db,
  log,
  deps = workerDependencies,
}: StartWorkerOptions): Closable => {
  const connection = deps.createConnection(env.REDIS_URL);
  // Before the worker exists, for the reason at the top of this file.
  deps.registerHandlers(connection);
  const worker = deps.createEventWorker({ redis: connection, db, log });
  // `status` is the same connection. The relay reports each cycle under
  // `hd:relay:last`, which is where `/metrics` and the System page learn that a
  // worker is alive and how big the outbox backlog is (ARCHITECTURE §14);
  // BullMQ owns its own client and does not lend it out, so the heartbeat needs
  // one it can use. Without it those readings are silently dead.
  const relay = deps.startRelay({
    db,
    redis: connection,
    log,
    listenUrl: env.DATABASE_URL,
    status: connection,
  });

  let closing: Promise<void> | undefined;
  const shutDown = async (): Promise<void> => {
    await relay.stop();
    await worker.close();
    await connection.quit();
  };

  return {
    // Idempotent, so a handler wired to both SIGTERM and SIGINT is safe.
    close: () => (closing ??= shutDown()),
  };
};
