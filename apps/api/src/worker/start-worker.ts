import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import {
  assignmentOfflineUnassignJob,
  createOutboxEventHandler,
  createQueueConnection,
  createWorker,
  type JobLogger,
  maintenanceRetentionJob,
  maintenanceRetentionScheduleJob,
  mediaProcessJob,
  type OutboxRelay,
  outboxEventJob,
  QUEUE_NAMES,
  RETENTION_CRON,
  type RelayStatusStore,
  startOutboxRelay,
} from '@helpdock/jobs';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import {
  createOfflineUnassignProcessor,
  registerAssignmentEventHandlers,
} from '../assignment/assignment-events.js';
import { RedisOfflineSinceStore, StorePresenceReader } from '../assignment/presence-adapters.js';
import { registerAttachmentEventHandlers } from '../media/attachment-events.js';
import { createMediaTools } from '../media/ffmpeg.js';
import { registerObjectPurgeHandler } from '../media/object-purge.js';
import { createMediaProcessor, TIMEOUTS_MS } from '../media/process.job.js';
import { createClamavScanner, type FileScanner } from '../media/scanner.js';
import { createS3Client, S3ObjectStorage } from '../media/storage.js';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { createMaintenanceProcessor } from '../retention/retention.job.js';
import { registerTicketEventHandlers } from '../tickets/ticket-events.js';

/**
 * What `APP_ROLE=worker` runs, in the order and with the shutdown order
 * `packages/jobs/README.md` specifies.
 *
 * 1. Handlers are registered before the worker starts. `settings.changed` ships
 *    registered by `@helpdock/jobs` itself; M1's ticket, attachment and
 *    assignment and object-purge events are registered here. A milestone that consumes a new event does the same,
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
  /** M1-07's `assignment.offline_unassign` consumer: the auto-unassign timer firing. */
  createAssignmentWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
  /**
   * M1-14's `maintenance` consumer and the nightly retention schedule. The
   * schedule is upserted on every boot, so a Redis that lost it gets it back
   * (DOMAIN-RULES §10: "repeatable pollers are re-registered on worker boot").
   */
  createMaintenanceWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
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
const storageFor = (env: WorkerEnv): S3ObjectStorage =>
  new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);

const scannerFor = (env: WorkerEnv): FileScanner | undefined =>
  env.CLAMAV_HOST === undefined
    ? undefined
    : createClamavScanner({
        host: env.CLAMAV_HOST,
        port: env.CLAMAV_PORT,
        timeoutMs: TIMEOUTS_MS.scan,
      });

/**
 * What M1-07 reads besides the database: presence, which M0-13 keeps in the
 * same Redis every api replica writes, and the latest departure per person.
 */
const assignmentReads = (redis: Redis) => {
  const presence = new StorePresenceReader(new PresenceStore(redis));

  return {
    repository: new AssignmentRepository(),
    presence,
    lookup: presence,
    offlineSince: new RedisOfflineSinceStore(redis),
  };
};

export const workerDependencies: WorkerDependencies = {
  createConnection: (url) => createQueueConnection(url),
  // The broadcast publishes on the same connection: a ticket event ends in a
  // socket frame, and only an `APP_ROLE=api` replica holds sockets
  // (`realtime/broadcast.ts`).
  registerHandlers: ({ redis, env }) => {
    const broadcast = new RedisRealtimeBroadcast(redis);
    registerTicketEventHandlers(broadcast);
    // M1-14: deletes the objects of attachments a purge or an erasure removed.
    registerObjectPurgeHandler(storageFor(env));

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

    // M1-07. `assignment.staff_offline` ends in a delayed job, for the same
    // reason and under the same rule as the media one above.
    const assignment = new Queue(QUEUE_NAMES.assignment, { connection: redis });
    registerAssignmentEventHandlers({
      ...assignmentReads(redis),
      queue: {
        add: async ({ jobId, delayMs, payload }) => {
          await assignment.add(assignmentOfflineUnassignJob.name, payload, {
            ...assignmentOfflineUnassignJob.options,
            jobId,
            delay: delayMs,
          });
        },
      },
    });

    return {
      close: async () => {
        await media.close();
        await assignment.close();
      },
    };
  },
  createEventWorker: ({ redis, db, log }) =>
    createWorker(outboxEventJob, createOutboxEventHandler(), { redis, db, log }),
  createMediaWorker: ({ redis, db, log, env }) =>
    createWorker(
      mediaProcessJob,
      createMediaProcessor({
        storage: storageFor(env),
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
  createAssignmentWorker: ({ redis, db, log }) =>
    createWorker(
      assignmentOfflineUnassignJob,
      createOfflineUnassignProcessor(assignmentReads(redis)),
      { redis, db, log },
    ),
  createMaintenanceWorker: ({ redis, db, log }) => {
    const maintenance = new Queue(QUEUE_NAMES.maintenance, { connection: redis });
    const scheduled = maintenance.upsertJobScheduler(
      maintenanceRetentionScheduleJob.name,
      { pattern: RETENTION_CRON, tz: 'UTC' },
      {
        name: maintenanceRetentionScheduleJob.name,
        data: {},
        opts: maintenanceRetentionScheduleJob.options,
      },
    );
    scheduled.catch((error: unknown) =>
      log.error({ err: error }, 'could not register the nightly retention schedule'),
    );

    const worker = new Worker(
      QUEUE_NAMES.maintenance,
      createMaintenanceProcessor({
        db,
        log,
        queue: {
          add: async (payload, jobId) => {
            await maintenance.add(maintenanceRetentionJob.name, payload, {
              ...maintenanceRetentionJob.options,
              jobId,
            });
          },
        },
      }),
      // One brand at a time: retention is background housekeeping, and two
      // brands purging at once would only compete for the same disk.
      { connection: redis, concurrency: 1 },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'maintenance job failed'),
    );

    return {
      close: async () => {
        await worker.close();
        await maintenance.close();
      },
    };
  },
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
  const assignment = deps.createAssignmentWorker({ redis: connection, db, log });
  const maintenance = deps.createMaintenanceWorker({ redis: connection, db, log });
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
    await assignment.close();
    await maintenance.close();
    await producers.close();
    await connection.quit();
  };

  return {
    // Idempotent, so a handler wired to both SIGTERM and SIGINT is safe.
    close: () => (closing ??= shutDown()),
  };
};
