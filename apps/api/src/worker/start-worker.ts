import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import {
  createOutboxEventHandler,
  createQueueConnection,
  createWorker,
  type JobLogger,
  type OutboxRelay,
  outboxEventJob,
  startOutboxRelay,
} from '@helpdock/jobs';
import type { Redis } from 'ioredis';

/**
 * What `APP_ROLE=worker` runs, in the order and with the shutdown order
 * `packages/jobs/README.md` specifies.
 *
 * 1. Handlers are registered before the worker starts. `settings.changed` ships
 *    registered by `@helpdock/jobs` itself, so importing it is enough today; a
 *    milestone that consumes a new event calls `registerEventHandler` here,
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

/** The three things this module starts. Boot passes BullMQ; a test passes doubles. */
export interface WorkerDependencies {
  createConnection(url: string): Redis;
  createEventWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
  startRelay(options: { db: Db; redis: Redis; log: JobLogger; listenUrl: string }): OutboxRelay;
}

export const workerDependencies: WorkerDependencies = {
  createConnection: (url) => createQueueConnection(url),
  createEventWorker: ({ redis, db, log }) =>
    createWorker(outboxEventJob, createOutboxEventHandler(), { redis, db, log }),
  startRelay: ({ db, redis, log, listenUrl }) => startOutboxRelay({ db, redis, log, listenUrl }),
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
  const worker = deps.createEventWorker({ redis: connection, db, log });
  const relay = deps.startRelay({ db, redis: connection, log, listenUrl: env.DATABASE_URL });

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
