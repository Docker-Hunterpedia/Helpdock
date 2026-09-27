import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import {
  assignmentOfflineUnassignJob,
  createOutboxEventHandler,
  createQueueConnection,
  createWorker,
  emailPollJob,
  emailSendJob,
  type JobLogger,
  maintenanceRetentionJob,
  maintenanceRetentionScheduleJob,
  mediaProcessJob,
  notifyEmailJob,
  notifyPushJob,
  type OutboxRelay,
  outboxEventJob,
  QUEUE_NAMES,
  RETENTION_CRON,
  type RelayStatusStore,
  RULES_TIME_BASED_CRON,
  registerEventHandler,
  rulesEvaluateJob,
  rulesEvaluateJobId,
  rulesTimeBasedJob,
  rulesTimeBasedScheduleJob,
  slaRebuildJob,
  startOutboxRelay,
} from '@helpdock/jobs';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import {
  createOfflineUnassignProcessor,
  registerAssignmentEventHandlers,
} from '../assignment/assignment-events.js';
import { RedisOfflineSinceStore, StorePresenceReader } from '../assignment/presence-adapters.js';
import {
  createEmailPollProcessor,
  createMailboxChangedHandler,
  MAILBOX_CHANGED_EVENT,
  queuePollScheduler,
  scheduleAllPollers,
} from '../channels/email-poll.job.js';
import { imapConnectOptions } from '../channels/imap-connector.js';
import { createInboundEmailService } from '../channels/inbound/factory.js';
import { MailboxesRepository } from '../channels/mailboxes.repository.js';
import { CsatRepository } from '../csat/csat.repository.js';
import { registerCsatEventHandlers } from '../csat/csat-events.js';
import { CsatTokens } from '../csat/tokens.js';
import { AutoReplyService } from '../email/auto-reply.service.js';
import { EmailRepository } from '../email/email.repository.js';
import { registerEmailEventHandlers } from '../email/email-events.js';
import { createEmailSendHandler, createEmailSendProcessor } from '../email/email-send.job.js';
import { OutboundEmailService } from '../email/outbound-email.service.js';
import { type InstallSmtp, SettingsInstallSmtp, smtpTransportFactory } from '../email/transport.js';
import { registerAttachmentEventHandlers } from '../media/attachment-events.js';
import { createMediaTools } from '../media/ffmpeg.js';
import { registerObjectPurgeHandler } from '../media/object-purge.js';
import { createMediaProcessor, TIMEOUTS_MS } from '../media/process.job.js';
import { createClamavScanner, type FileScanner } from '../media/scanner.js';
import { createS3Client, S3ObjectStorage } from '../media/storage.js';
import { createNotifyProcessor } from '../notifications/delivery.js';
import { InstallChannels } from '../notifications/install-channels.js';
import { registerNotificationHandlers } from '../notifications/notification-events.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { WebPushSender } from '../notifications/push.js';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { createMaintenanceProcessor } from '../retention/retention.job.js';
import { createRulesEngineDeps } from '../rules/engine-deps.js';
import { createRulesProcessor, registerRulesEventHandlers } from '../rules/rules-jobs.js';
import { BusinessHoursService } from '../sla/business-hours.service.js';
import { businessHoursProbe } from '../sla/business-hours-probe.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { bullTimerQueue } from '../sla/sla-timers.js';
import {
  createSlaProcessor,
  registerSlaEventHandlers,
  type SlaWorkerDeps,
} from '../sla/sla-worker.js';
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
  registerHandlers(options: {
    redis: Redis;
    env: WorkerEnv;
    settings: WorkerSettings;
    installSmtp: InstallSmtp;
  }): Closable;
  createEventWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
  /** M2-05's `email.send` consumer on the `outbound` queue. */
  createEmailWorker(options: {
    redis: Redis;
    db: Db;
    log: JobLogger;
    env: WorkerEnv;
    installSmtp: InstallSmtp;
  }): Closable;
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
  /**
   * M2-02's `inbound` consumer: one `email.poll` tick per IMAP mailbox. Every
   * mailbox's scheduler is upserted on boot, as the retention schedule is.
   */
  createInboundWorker(options: { redis: Redis; db: Db; log: JobLogger; env: WorkerEnv }): Closable;
  /**
   * M3-02's `sla` consumer: the timers of DOMAIN-RULES §3.4 and `sla.rebuild`,
   * which is added on every boot and hourly after, so a Redis that lost its
   * timers gets every one of them back (§10).
   */
  createSlaWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
  /**
   * M3-03 and M3-04's `rules` consumer: event rules, and the five-minute tick
   * for time-based rules, whose schedule is upserted on every boot for the
   * reason the retention schedule is.
   */
  createRulesWorker(options: { redis: Redis; db: Db; log: JobLogger }): Closable;
  /** M3-07's `notify` consumer: notification emails and web pushes. */
  createNotifyWorker(options: {
    redis: Redis;
    db: Db;
    log: JobLogger;
    env: WorkerEnv;
    settings: WorkerSettings;
  }): Closable;
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
  // M1-12: the survey job signs the rating link, so it holds the key the api
  // verifies it with.
  | 'APP_MASTER_KEY'
  | 'APP_MASTER_KEY_PREVIOUS'
  // M3-07: links in notification emails, the VAPID subject, and the private
  // ranges a push endpoint may be in (DOMAIN-RULES §13).
  | 'APP_URL'
  // M2-02: an IMAP host is resolved through the same policy.
  | 'OUTBOUND_ALLOW_CIDRS'
>;

/** What the worker reads from settings: the SMTP sender and the VAPID key pair (M3-07). */
export type WorkerSettings = Pick<Settings, 'get'>;

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

/** M3-01's calendar, for M2-06's out-of-hours reply. */
const businessHoursService = (): BusinessHoursService => {
  const repository = new SlaRepository();

  return new BusinessHoursService(repository, new SlaService(repository));
};

/** What M3-02's handler and consumer read and write through. */
const slaDeps = (queue: Queue): SlaWorkerDeps => {
  const repository = new SlaRepository();

  return {
    repository,
    sla: new SlaService(repository),
    assignment: new AssignmentRepository(),
    timers: bullTimerQueue(queue),
  };
};

export const workerDependencies: WorkerDependencies = {
  createConnection: (url) => createQueueConnection(url),
  // The broadcast publishes on the same connection: a ticket event ends in a
  // socket frame, and only an `APP_ROLE=api` replica holds sockets
  // (`realtime/broadcast.ts`).
  registerHandlers: ({ redis, env, settings, installSmtp }) => {
    const broadcast = new RedisRealtimeBroadcast(redis);
    registerTicketEventHandlers(broadcast);
    // M1-14: deletes the objects of attachments a purge or an erasure removed.
    registerObjectPurgeHandler(storageFor(env));
    registerCsatEventHandlers({
      repository: new CsatRepository(),
      tokens: new CsatTokens(createKeyring(env)),
    });

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

    // M2-05 and M2-06. `email.send` ends in a job on the `outbound` queue, under
    // the same rule as the two above: `jobId` is the outbox row's, so a
    // redelivered event adds nothing. `email.received` decides the auto-reply,
    // reading M3-01's business hours for the out-of-hours one.
    const outbound = new Queue(QUEUE_NAMES.outbound, { connection: redis });
    const emailRepository = new EmailRepository();
    registerEmailEventHandlers({
      queue: {
        add: async ({ jobId, payload }) => {
          await outbound.add(emailSendJob.name, payload, { ...emailSendJob.options, jobId });
        },
      },
      autoReplies: new AutoReplyService(
        emailRepository,
        new OutboundEmailService(emailRepository, installSmtp),
        businessHoursProbe(businessHoursService()),
      ),
    });
    // M2-02. A mailbox created, edited or deleted reschedules its poller.
    const inbound = new Queue(QUEUE_NAMES.inbound, { connection: redis });
    registerEventHandler(
      MAILBOX_CHANGED_EVENT,
      createMailboxChangedHandler(new MailboxesRepository(), queuePollScheduler(inbound)),
    );
    // M3-03. Every ticket, SLA and CSAT event ends in a `rules.evaluate` job,
    // with a job id derived from the outbox row, so a redelivery adds nothing.
    const rules = new Queue(QUEUE_NAMES.rules, { connection: redis });
    registerRulesEventHandlers({
      add: async (payload) => {
        await rules.add(rulesEvaluateJob.name, payload, {
          ...rulesEvaluateJob.options,
          jobId: rulesEvaluateJobId(payload),
        });
      },
    });
    // M3-02. `sla.schedule` removes and re-adds a ticket's timers, the same
    // shape as the two above.
    const sla = new Queue(QUEUE_NAMES.sla, { connection: redis });
    registerSlaEventHandlers(slaDeps(sla));

    // M3-07. After the ticket handlers, so on the events both handle the
    // socket frame goes first. It owns `ticket.assigned`, `ticket.escalated`,
    // `rule.notify` and `notification.*`, and subscribes to the ticket and SLA
    // events; `notification.created` adds `notify` jobs under the same rule
    // as the queues above, with ids derived from the row.
    const notify = new Queue(QUEUE_NAMES.notify, { connection: redis });
    const channels = new InstallChannels(settings);
    registerNotificationHandlers({
      repository: new NotificationsRepository(),
      broadcast,
      pushConfigured: async () => (await channels.vapidKeys()) !== null,
      queue: {
        addEmail: async (jobId, payload) => {
          await notify.add(notifyEmailJob.name, payload, { ...notifyEmailJob.options, jobId });
        },
        addPush: async (jobId, payload) => {
          await notify.add(notifyPushJob.name, payload, { ...notifyPushJob.options, jobId });
        },
      },
    });

    return {
      close: async () => {
        await media.close();
        await assignment.close();
        await outbound.close();
        await inbound.close();
        await sla.close();
        await rules.close();
        await notify.close();
      },
    };
  },
  createEventWorker: ({ redis, db, log }) =>
    createWorker(outboxEventJob, createOutboxEventHandler(), { redis, db, log }),
  createEmailWorker: ({ redis, db, log, env, installSmtp }) => {
    const repository = new EmailRepository();
    const worker = new Worker(
      QUEUE_NAMES.outbound,
      createEmailSendProcessor({
        db,
        log,
        repository,
        handler: createEmailSendHandler({
          repository,
          keyring: createKeyring(env),
          installSmtp,
          transports: smtpTransportFactory,
        }),
      }),
      { connection: redis },
    );
    worker.on('failed', (job, error) =>
      log.error(
        { job: job?.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
        'email.send failed',
      ),
    );
    return worker;
  },
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
  createInboundWorker: ({ redis, db, log, env }) => {
    const inbound = new Queue(QUEUE_NAMES.inbound, { connection: redis });
    const repository = new MailboxesRepository();
    scheduleAllPollers(db, repository, queuePollScheduler(inbound)).catch((error: unknown) =>
      log.error({ err: error }, 'could not register the IMAP pollers'),
    );

    const poll = createEmailPollProcessor({
      db,
      log,
      keyring: createKeyring(env),
      repository,
      inbound: createInboundEmailService({ db, storage: storageFor(env), log }),
      imap: imapConnectOptions({
        allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
        onBlocked: (event) =>
          log.warn(
            { host: event.host, address: event.address },
            'IMAP host blocked (DOMAIN-RULES §13)',
          ),
      }),
    });
    const worker = new Worker(
      QUEUE_NAMES.inbound,
      async (job) => {
        // `telegram.update` and `form.submit` share this queue from M4 and M6.
        if (job.name !== emailPollJob.name) {
          throw new UnrecoverableError(`No consumer for ${job.name} on the inbound queue`);
        }
        await poll(job);
      },
      // A few mailboxes at once: each tick is mostly waiting on a mail server.
      { connection: redis, concurrency: 4 },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'inbound job failed'),
    );

    return {
      close: async () => {
        await worker.close();
        await inbound.close();
      },
    };
  },
  createSlaWorker: ({ redis, db, log }) => {
    const queue = new Queue(QUEUE_NAMES.sla, { connection: redis });
    const addRebuild = async (brandId: string | undefined, jobId: string): Promise<void> => {
      await queue.add(slaRebuildJob.name, brandId === undefined ? {} : { brandId }, {
        ...slaRebuildJob.options,
        jobId,
      });
    };
    // On boot, and hourly after: DOMAIN-RULES §3.4's "on worker boot,
    // `sla.rebuild` scans open tickets and re-creates missing timers". The
    // hourly tick also catches a timer lost to a race between a timer running
    // and its clock being rescheduled.
    addRebuild(undefined, `${slaRebuildJob.name}.boot.${String(Date.now())}`).catch(
      (error: unknown) => log.error({ err: error }, 'could not add the boot SLA rebuild'),
    );
    queue
      .upsertJobScheduler(
        slaRebuildJob.name,
        { every: 3_600_000 },
        { name: slaRebuildJob.name, data: {}, opts: slaRebuildJob.options },
      )
      .catch((error: unknown) =>
        log.error({ err: error }, 'could not register the hourly SLA rebuild'),
      );

    const worker = new Worker(
      QUEUE_NAMES.sla,
      createSlaProcessor({ db, deps: slaDeps(queue), log, addRebuild }),
      { connection: redis, concurrency: 5 },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'sla job failed'),
    );

    return {
      close: async () => {
        await worker.close();
        await queue.close();
      },
    };
  },
  createRulesWorker: ({ redis, db, log }) => {
    const rules = new Queue(QUEUE_NAMES.rules, { connection: redis });
    rules
      .upsertJobScheduler(
        rulesTimeBasedScheduleJob.name,
        { pattern: RULES_TIME_BASED_CRON, tz: 'UTC' },
        { name: rulesTimeBasedScheduleJob.name, data: {}, opts: rulesTimeBasedScheduleJob.options },
      )
      .catch((error: unknown) =>
        log.error({ err: error }, 'could not register the time-based rules schedule'),
      );

    const worker = new Worker(
      QUEUE_NAMES.rules,
      createRulesProcessor({
        db,
        log,
        engine: createRulesEngineDeps({ log }),
        queue: {
          add: async (payload, jobId) => {
            await rules.add(rulesTimeBasedJob.name, payload, {
              ...rulesTimeBasedJob.options,
              jobId,
            });
          },
        },
      }),
      { connection: redis },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'rules job failed'),
    );

    return {
      close: async () => {
        await worker.close();
        await rules.close();
      },
    };
  },
  createNotifyWorker: ({ redis, db, log, env, settings }) => {
    const worker = new Worker(
      QUEUE_NAMES.notify,
      createNotifyProcessor(
        {
          repository: new NotificationsRepository(),
          settings: new InstallChannels(settings),
          push: new WebPushSender({ subject: env.APP_URL, allowCidrs: env.OUTBOUND_ALLOW_CIDRS }),
          appUrl: env.APP_URL,
        },
        { db, log },
      ),
      { connection: redis },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'notify job failed'),
    );

    return { close: () => worker.close() };
  },
  startRelay: ({ db, redis, log, listenUrl, status }) =>
    startOutboxRelay({ db, redis, log, listenUrl, status }),
};

export interface StartWorkerOptions {
  readonly env: WorkerEnv;
  readonly db: Db;
  /**
   * The install's settings: the `smtp.*` server a brand without its own sends
   * through (M2-05), which is also the system sender of staff notification
   * emails, and the VAPID key pair of web push (M3-07).
   */
  readonly settings: WorkerSettings;
  readonly log: JobLogger;
  readonly deps?: WorkerDependencies;
}

export const startWorker = ({
  env,
  db,
  settings,
  log,
  deps = workerDependencies,
}: StartWorkerOptions): Closable => {
  const installSmtp = new SettingsInstallSmtp(settings);
  const connection = deps.createConnection(env.REDIS_URL);
  // Before either worker exists, for the reason at the top of this file.
  const producers = deps.registerHandlers({
    redis: connection,
    env,
    settings,
    installSmtp,
  });
  const worker = deps.createEventWorker({ redis: connection, db, log });
  const email = deps.createEmailWorker({ redis: connection, db, log, env, installSmtp });
  const media = deps.createMediaWorker({ redis: connection, db, log, env });
  const assignment = deps.createAssignmentWorker({ redis: connection, db, log });
  const maintenance = deps.createMaintenanceWorker({ redis: connection, db, log });
  const inbound = deps.createInboundWorker({ redis: connection, db, log, env });
  const sla = deps.createSlaWorker({ redis: connection, db, log });
  const rules = deps.createRulesWorker({ redis: connection, db, log });
  const notify = deps.createNotifyWorker({ redis: connection, db, log, env, settings });
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
    // After the event worker, which adds its jobs, like the media worker below.
    await email.close();
    // After the event worker, because that is what adds media jobs: closing the
    // media worker first would leave a job queued with nothing draining it,
    // which is harmless but slower to notice than the other order's bug.
    await media.close();
    await assignment.close();
    await maintenance.close();
    await inbound.close();
    await sla.close();
    await rules.close();
    await notify.close();
    await producers.close();
    await connection.quit();
  };

  return {
    // Idempotent, so a handler wired to both SIGTERM and SIGINT is safe.
    close: () => (closing ??= shutDown()),
  };
};
