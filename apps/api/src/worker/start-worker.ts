import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import {
  createOutboxEventHandler,
  createQueueConnection,
  createWorker,
  type JobLogger,
  mediaProcessJob,
  type OutboxRelay,
  outboxEventJob,
  QUEUE_NAMES,
  type RelayStatusStore,
  startOutboxRelay,
} from '@helpdock/jobs';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { registerAttachmentEventHandlers } from '../media/attachment-events.js';
import { createMediaTools } from '../media/ffmpeg.js';
import { createMediaProcessor, TIMEOUTS_MS } from '../media/process.job.js';
import { createClamavScanner, type FileScanner } from '../media/scanner.js';
import { createS3Client, S3ObjectStorage } from '../media/storage.js';
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

/** What this module does. Boot passes BullMQ; a test passes doubles. */
export interface WorkerDependencies {
  createConnection(url: string): Redis;
  /**
   * Registers this milestone's outbox handlers. It is a dependency rather than
   * a plain call because the dispatcher is a process-wide registry that refuses
   * a second registration of the same event — which is what a test starting
   * several workers in one process would do.
   */
  registerHandlers(options: { redis: Redis; env: WorkerEnv }): Closable;
  createEventWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
  /** M1-10's `media.process` consumer: sharp, ffmpeg and the optional scanner. */
  createMediaWorker(options: { redis: Redis; db: Db; log: JobLogger; env: WorkerEnv }): Closable;
  startRelay(options: {
    db: Db;
    redis: Redis;
    log: JobLogger;
    listenUrl: string;
    status: RelayStatusStore;
  }): OutboxRelay;
}

/** The bootstrap keys the worker's half of M1-10 reads (ARCHITECTURE §4). */
export type WorkerEnv = Pick<
  Env,
  | 'REDIS_URL'
  | 'DATABASE_URL'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
  | 'FFMPEG_PATH'
  | 'FFPROBE_PATH'
  | 'CLAMAV_HOST'
  | 'CLAMAV_PORT'
>;

/**
 * The scanner, or nothing. ARCHITECTURE §17 makes ClamAV optional and
 * `CLAMAV_HOST` is the switch: unset means every file is `scan_status =
 * skipped`, and a host that is set and unreachable is a rejection rather than a
 * silent pass (`scanner.ts`).
 */
const scannerFor = (env: WorkerEnv): FileScanner | undefined =>
  env.CLAMAV_HOST === undefined
    ? undefined
    : createClamavScanner({
        host: env.CLAMAV_HOST,
        port: env.CLAMAV_PORT,
        timeoutMs: TIMEOUTS_MS.scan,
      });

export const workerDependencies: WorkerDependencies = {
  createConnection: (url) => createQueueConnection(url),
  // The broadcast publishes on the same connection: a ticket event ends in a
  // socket frame, and only an `APP_ROLE=api` replica holds sockets
  // (`realtime/broadcast.ts`).
  registerHandlers: ({ redis }) => {
    const broadcast = new RedisRealtimeBroadcast(redis);
    registerTicketEventHandlers(broadcast);

    // `attachment.uploaded` ends in a job on the `media` queue, so its handler
    // needs a producer. It is the one outbox handler that adds a job, and it
    // may: it runs after the confirm committed, and `jobId = attachmentId`
    // makes a redelivery a no-op (`media/attachment-events.ts`).
    const media = new Queue(QUEUE_NAMES.media, { connection: redis });
    registerAttachmentEventHandlers({
      broadcast,
      queue: {
        add: async ({ jobId, payload }) => {
          await media.add(mediaProcessJob.name, payload, {
            ...mediaProcessJob.options,
            jobId,
          });
        },
      },
    });

    return { close: () => media.close() };
  },
  createEventWorker: ({ redis, db, log }) =>
    createWorker(outboxEventJob, createOutboxEventHandler(), { redis, db, log }),
  createMediaWorker: ({ redis, db, log, env }) =>
    createWorker(
      mediaProcessJob,
      createMediaProcessor({
        storage: new S3ObjectStorage(createS3Client(env), env.S3_BUCKET),
        tools: createMediaTools({ ffmpeg: env.FFMPEG_PATH, ffprobe: env.FFPROBE_PATH }),
        scanner: scannerFor(env),
      }),
      {
        redis,
        db,
        log,
        // One at a time. sharp and ffmpeg are CPU-bound and a worker that runs
        // four conversions at once on a small VPS starves everything else on
        // it; more replicas is the way to scale this, not more concurrency.
        concurrency: 1,
      },
    ),
  startRelay: ({ db, redis, log, listenUrl, status }) =>
    startOutboxRelay({ db, redis, log, listenUrl, status }),
};

export interface StartWorkerOptions {
  readonly env: WorkerEnv;
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
  // Before either worker exists, for the reason at the top of this file.
  const producers = deps.registerHandlers({ redis: connection, env });
  const worker = deps.createEventWorker({ redis: connection, db, log });
  const media = deps.createMediaWorker({ redis: connection, db, log, env });
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
    // After the event worker, because that is what adds media jobs: closing the
    // media worker first would leave a job queued with nothing draining it,
    // which is harmless but slower to notice than the other order's bug.
    await media.close();
    await producers.close();
    await connection.quit();
  };

  return {
    // Idempotent, so a handler wired to both SIGTERM and SIGINT is safe.
    close: () => (closing ??= shutDown()),
  };
};
