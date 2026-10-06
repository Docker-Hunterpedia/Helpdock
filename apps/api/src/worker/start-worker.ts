import { createKeyring, type Env, type Settings } from '@helpdock/config';
import { brands, type Db } from '@helpdock/db';
import {
  aiAutoReplyJob,
  aiClassifyJob,
  aiTranscribeJob,
  assignmentOfflineUnassignJob,
  authEmailJob,
  BRAND_PURGE_CRON,
  brandPurgeJob,
  brandPurgeScheduleJob,
  createJobProcessor,
  createOutboxEventHandler,
  createQueueConnection,
  createWorker,
  DOMAIN_VERIFY_CRON,
  domainVerifyJob,
  domainVerifyScheduleJob,
  emailPollJob,
  emailPollSchedulerId,
  emailSendJob,
  helpCenterMediaProcessJob,
  helpCenterPublishDueJob,
  helpCenterPublishDueSweepJob,
  helpCenterSearchReindexJob,
  helpCenterSearchReindexSweepJob,
  type JobLogger,
  knowledgeConfigureJob,
  knowledgeEmbedJob,
  knowledgeReembedJob,
  knowledgeSyncJob,
  knowledgeSyncSchedulerId,
  maintenanceRetentionJob,
  maintenanceRetentionScheduleJob,
  mediaProcessJob,
  notifyEmailJob,
  notifyPushJob,
  type OutboxRelay,
  outboxEventJob,
  outboxJobOrderingKeys,
  QUEUE_NAMES,
  RETENTION_CRON,
  type RelayStatusStore,
  RULES_TIME_BASED_CRON,
  registerEventHandler,
  rulesEvaluateJob,
  rulesEvaluateJobId,
  rulesTimeBasedJob,
  rulesTimeBasedScheduleJob,
  STATS_ROLLUP_CRON,
  slaRebuildJob,
  startOutboxRelay,
  statsRollupJob,
  statsRollupScheduleJob,
  telegramPollJob,
  telegramSendJob,
  webhookDeliverJob,
} from '@helpdock/jobs';
import type { BlockedEvent } from '@helpdock/net';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { safeAiTransport } from '../ai/ai-http.js';
import { createAutoReplyProcessor } from '../ai/auto-reply/auto-reply.job.js';
import { createAutoReplyDeps } from '../ai/auto-reply/auto-reply-deps.js';
import { registerAutoReplyEventHandlers } from '../ai/auto-reply/auto-reply-events.js';
import { readAutoReplySettings } from '../ai/auto-reply/auto-reply-settings.js';
import { registerAiEventHandlers } from '../ai/budget-alert.handler.js';
import { createAiRuntime } from '../ai/db-ai-ports.js';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import {
  createOfflineUnassignProcessor,
  type OfflineUnassignQueue,
  registerAssignmentEventHandlers,
} from '../assignment/assignment-events.js';
import { RedisOfflineSinceStore, StorePresenceReader } from '../assignment/presence-adapters.js';
import { createAuthEmailEventHandler, createAuthEmailProcessor } from '../auth/auth-email.job.js';
import { AUTH_EMAIL_EVENT } from '../auth/auth-email.js';
import { createBrandPurgeProcessor } from '../brands/brand-purge.job.js';
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
import { registerContactEventHandlers } from '../contacts/contact-events.js';
import { CsatRepository } from '../csat/csat.repository.js';
import { CsatDelivery } from '../csat/csat-delivery.js';
import { CsatEmailSource } from '../csat/csat-email.js';
import { registerCsatEventHandlers } from '../csat/csat-events.js';
import { CsatTelegramNotices } from '../csat/telegram-csat.js';
import { CsatTokens } from '../csat/tokens.js';
import { cnameTargetOf, createDomainProbes } from '../domains/domain-config.js';
import {
  createDomainsProcessor,
  type DomainsQueue,
  registerDomainEventHandlers,
} from '../domains/domain-jobs.js';
import { DomainVerifier } from '../domains/domain-verifier.js';
import { DomainsRepository } from '../domains/domains.repository.js';
import { AutoReplyService } from '../email/auto-reply.service.js';
import { EmailRepository } from '../email/email.repository.js';
import { registerEmailEventHandlers } from '../email/email-events.js';
import { createEmailSendHandler, createEmailSendProcessor } from '../email/email-send.job.js';
import { OutboundEmailService } from '../email/outbound-email.service.js';
import { type InstallSmtp, SettingsInstallSmtp, smtpTransportFactory } from '../email/transport.js';
import { registerHelpCenterEventHandlers } from '../help-center/events.js';
import { createHcMediaProcessor } from '../help-center/media-process.job.js';
import { createHelpCenterKnowledgeProcessor } from '../help-center/publish-due.job.js';
import {
  createSearchKnowledgeProcessor,
  registerSearchEventHandlers,
} from '../help-center/search/search-events.js';
import { registerPageCacheHandlers } from '../help-center/site/cache-events.js';
import { RedisPageCache } from '../help-center/site/page-cache.js';
import { createPlaywrightRenderer } from '../knowledge/crawl-renderer.js';
import { readOAuthApps } from '../knowledge/credentials.js';
import { createEmbeddingSpaceProcessor } from '../knowledge/embedding-space.job.js';
import {
  type KnowledgeQueues,
  registerKnowledgeEventHandlers,
  scheduleBrandSources,
} from '../knowledge/knowledge-events.js';
import type { SourceLoaderDeps } from '../knowledge/load-source.js';
import {
  safeCrawlFetch,
  safeFetchFunction,
  safeRenderFetch,
} from '../knowledge/safe-transports.js';
import { createKnowledgeSyncProcessor } from '../knowledge/sync.job.js';
import { registerAttachmentEventHandlers } from '../media/attachment-events.js';
import { S3BrandObjects } from '../media/brand-objects.js';
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
import { StorageUsageStore } from '../observability/storage-usage.js';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { createStatsProcessor } from '../reports/rollup.job.js';
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
import { telegramApiFactory } from '../telegram/bot-api-factory.js';
import { createTelegramInboundService } from '../telegram/factory.js';
import { TelegramRepository } from '../telegram/telegram.repository.js';
import { registerTelegramEventHandlers } from '../telegram/telegram-events.js';
import {
  createTelegramBotChangedHandler,
  createTelegramPollProcessor,
  queueTelegramPollScheduler,
  scheduleAllTelegramPollers,
} from '../telegram/telegram-poll.job.js';
import {
  createTelegramSendHandler,
  createTelegramSendProcessor,
} from '../telegram/telegram-send.job.js';
import { withSystemJob } from '../tenant/system-job.js';

import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { registerTicketEventHandlers } from '../tickets/ticket-events.js';
import { createTranscribeProcessor } from '../transcription/transcribe.job.js';
import { transcriptionConfigFrom } from '../transcription/transcription-config.js';
import { registerTranscriptionHandlers } from '../transcription/transcription-events.js';
import { createTriageProcessor } from '../triage/triage.job.js';
import { registerTriageEventHandlers } from '../triage/triage-events.js';
import { createWebhookDeliverProcessor } from '../webhooks/webhook-deliver.job.js';
import { registerWebhookEventHandlers } from '../webhooks/webhook-events.js';
import { WebhooksRepository } from '../webhooks/webhooks.repository.js';
import { registerWidgetEventHandlers } from '../widget/widget-events.js';
import { RedisWidgetBroadcast } from '../widget/widget-relay.js';

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
  createEventWorker(options: { redis: Redis; db: Db; log: JobLogger; env: WorkerEnv }): Closable;
  /** The `outbound` queue: M2-05's `email.send` and M6-02's `telegram.send`. */
  createOutboundWorker(options: {
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
  createMaintenanceWorker(options: {
    redis: Redis;
    db: Db;
    log: JobLogger;
    env: WorkerEnv;
  }): Closable;
  /**
   * M2-02's `inbound` consumer: one `email.poll` tick per IMAP mailbox, and in
   * development M6-01's `telegram.poll` per bot. Every scheduler is upserted
   * on boot, as the retention schedule is.
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
  /**
   * M5-01's `knowledge` consumer: the scheduled publish, and the hourly sweep
   * that re-adds it per brand, whose schedule is upserted on every boot for
   * the reason the retention schedule is. M7-02 adds the embedding space's
   * minute tick and the re-embed it starts.
   */
  createHelpCenterWorker(options: {
    redis: Redis;
    db: Db;
    log: JobLogger;
    env: WorkerEnv;
    settings: WorkerSettings;
  }): Closable;
  /** M3-07's `notify` consumer: notification emails and web pushes, and the auth emails. */
  createNotifyWorker(options: {
    redis: Redis;
    db: Db;
    log: JobLogger;
    env: WorkerEnv;
    settings: WorkerSettings;
  }): Closable;
  /**
   * M5-07's `domains` consumer: custom-domain DNS and TLS checks, and the
   * fifteen-minute re-check schedule, upserted on every boot for the reason
   * the retention schedule is.
   */
  createDomainsWorker(options: { redis: Redis; db: Db; log: JobLogger; env: WorkerEnv }): Closable;
  /**
   * The `ai` consumer: M7-06's `ai.auto_reply`, one customer message answered or
   * handed off; M7-07's `ai.classify` and M7-09's `ai.transcribe`. It sends through the channels' outbound paths, so it holds
   * the install's SMTP sender like the outbound worker.
   */
  createAiWorker(options: {
    redis: Redis;
    db: Db;
    log: JobLogger;
    env: WorkerEnv;
    settings: WorkerSettings;
    installSmtp: InstallSmtp;
  }): Closable;
  /** M8-03's `webhooks` consumer: one signed POST per delivery, through `@helpdock/net`. */
  createWebhooksWorker(options: { redis: Redis; db: Db; log: JobLogger; env: WorkerEnv }): Closable;
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
  // M5-07: where a custom domain's CNAME must point.
  | 'HELPCENTER_CNAME_TARGET'
  // M6: whether bots are polled, and where the Bot API is.
  | 'TELEGRAM_POLLING'
  | 'TELEGRAM_API_ROOT'
  // M7-03: whether a website crawl may render pages in a headless browser.
  | 'KNOWLEDGE_CRAWL_RENDER'
  // M9: how many outbox events run at once.
  | 'OUTBOX_CONCURRENCY'
>;

/**
 * Outbox events one worker runs at once when `OUTBOX_CONCURRENCY` is unset.
 * Each holds a database connection while it runs, out of the pool's ten, and
 * the other consumers need theirs.
 */
export const DEFAULT_OUTBOX_CONCURRENCY = 8;

/**
 * What the worker reads from settings: the SMTP sender and the VAPID key pair
 * (M3-07), the AI providers and the embedding model (M7). It writes one thing:
 * OAuth tokens a provider call refreshed.
 */
export type WorkerSettings = Pick<Settings, 'get' | 'set'>;

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

/** M1-07's delayed timers, added under the id the caller derived from the departure. */
const offlineUnassignQueue = (queue: Queue): OfflineUnassignQueue => ({
  add: async ({ jobId, delayMs, payload }) => {
    await queue.add(assignmentOfflineUnassignJob.name, payload, {
      ...assignmentOfflineUnassignJob.options,
      jobId,
      delay: delayMs,
    });
  },
});

/** M3-01's calendar, for M2-06's out-of-hours reply and M1-07's offline timer. */
const businessHoursService = (): BusinessHoursService => {
  const repository = new SlaRepository();

  return new BusinessHoursService(repository, new SlaService(repository));
};

/** M5-07: adds `domain.verify` jobs on the `domains` queue, under the id the caller derived. */
const domainsQueueOf = (queue: Queue): DomainsQueue => ({
  add: async (payload, jobId) => {
    await queue.add(domainVerifyJob.name, payload, { ...domainVerifyJob.options, jobId });
  },
});

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

/** M7-03's handlers and boot reach the `knowledge` queue through this. */
const knowledgeQueuesOf = (queue: Queue): KnowledgeQueues => ({
  addSync: async (payload, jobId) => {
    await queue.add(knowledgeSyncJob.name, payload, { ...knowledgeSyncJob.options, jobId });
  },
  addEmbed: async (payload, jobId) => {
    await queue.add(knowledgeEmbedJob.name, payload, { ...knowledgeEmbedJob.options, jobId });
  },
  schedule: async (sourceId, cron, payload) => {
    const id = knowledgeSyncSchedulerId(sourceId);
    if (cron === null) {
      await queue.removeJobScheduler(id);
      return;
    }
    await queue.upsertJobScheduler(
      id,
      { pattern: cron.pattern, tz: cron.tz },
      { name: knowledgeSyncJob.name, data: payload, opts: knowledgeSyncJob.options },
    );
  },
});

/** Every brand's daily and weekly sources, re-registered on boot (DOMAIN-RULES §10). */
const scheduleAllKnowledgeSources = async (db: Db, queues: KnowledgeQueues): Promise<void> => {
  const active = await db.select({ id: brands.id }).from(brands).where(eq(brands.status, 'active'));
  for (const { id: brandId } of active) {
    await withSystemJob(db, brandId, 'knowledge.schedule.boot', (tx) =>
      scheduleBrandSources(tx, brandId, queues),
    );
  }
};

/** What a source sync reads through: the bucket, and the SSRF-safe client for everything else. */
const knowledgeLoaders = (
  env: WorkerEnv,
  settings: WorkerSettings,
  log: JobLogger,
): SourceLoaderDeps => {
  const transport = {
    allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
    onBlocked: (event: BlockedEvent) =>
      log.warn(
        { host: event.host, address: event.address, url: event.url },
        'knowledge fetch blocked (DOMAIN-RULES §13)',
      ),
  };
  return {
    storage: storageFor(env),
    crawlFetch: safeCrawlFetch(transport),
    renderer:
      env.KNOWLEDGE_CRAWL_RENDER === true
        ? () => createPlaywrightRenderer(safeRenderFetch(transport))
        : null,
    fetch: safeFetchFunction(transport),
    keyring: createKeyring(env),
    oauthApps: () => readOAuthApps(settings),
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
    // M4-04: the same ticket events as widget frames, on the widget's channel.
    registerWidgetEventHandlers(new RedisWidgetBroadcast(redis));
    // M1-14: deletes the objects of attachments a purge or an erasure removed.
    registerObjectPurgeHandler(storageFor(env));
    // M7-08: a brand reached 80 % or 100 % of an AI budget window.
    registerAiEventHandlers();
    // M8-06: the survey goes out on the ticket's channel in the survey job.
    const csatRepository = new CsatRepository();
    registerCsatEventHandlers({
      repository: csatRepository,
      tokens: new CsatTokens(createKeyring(env)),
      delivery: new CsatDelivery({
        repository: csatRepository,
        email: new OutboundEmailService(new EmailRepository(), installSmtp),
        telegram: new TelegramRepository(),
        locales: new TicketLifecycleRepository(),
        widget: new RedisWidgetBroadcast(redis),
      }),
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
      queue: offlineUnassignQueue(assignment),
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
    // M6-02, M6-04. A reply to a chat and a bot's welcome end in a
    // `telegram.send` job on the `outbound` queue, under the same rule as
    // `email.send`; a bot saved or removed reschedules its development poller.
    registerTelegramEventHandlers({
      queue: {
        add: async ({ jobId, payload }) => {
          await outbound.add(telegramSendJob.name, payload, { ...telegramSendJob.options, jobId });
        },
      },
      botChanged: createTelegramBotChangedHandler(
        new TelegramRepository(),
        queueTelegramPollScheduler(inbound),
        env.TELEGRAM_POLLING === true,
      ),
    });
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
    // Sign-in links, password resets and invitations: one `auth.email` job per
    // outbox row, on the `notify` queue beside the other staff email, with a
    // job id derived from the row under the same rule as above.
    registerEventHandler(
      AUTH_EMAIL_EVENT,
      createAuthEmailEventHandler({
        add: async (jobId, payload) => {
          await notify.add(authEmailJob.name, payload, { ...authEmailJob.options, jobId });
        },
      }),
    );

    // M5-07. "Add", "Check now" and the Cloudflare flag end in a
    // `domain.verify` job, with a job id derived from the outbox row.
    const domains = new Queue(QUEUE_NAMES.domains, { connection: redis });
    registerDomainEventHandlers(domainsQueueOf(domains));

    // M5-01, M5-02. A scheduled article adds a delayed publish on the
    // `knowledge` queue, and a confirmed article image adds its conversion on
    // `media`, both with ids derived from the rows, under the rule above.
    const knowledge = new Queue(QUEUE_NAMES.knowledge, { connection: redis });
    registerHelpCenterEventHandlers({
      addMediaProcess: async (payload) => {
        await media.add(helpCenterMediaProcessJob.name, payload, {
          ...helpCenterMediaProcessJob.options,
          jobId: `${helpCenterMediaProcessJob.name}.${payload.mediaId}`,
        });
      },
      addPublishDue: async (payload, jobId, delayMs) => {
        await knowledge.add(helpCenterPublishDueJob.name, payload, {
          ...helpCenterPublishDueJob.options,
          jobId,
          delay: delayMs,
        });
      },
    });
    // M5-05. The search index follows the same three events under its own
    // subscriber name, in the event's transaction.
    registerSearchEventHandlers();
    // M7-03. So do the knowledge base's article chunks; and a source added,
    // re-scheduled, synced or removed adds its job or moves its scheduler.
    registerKnowledgeEventHandlers(knowledgeQueuesOf(knowledge), storageFor(env));

    // M7-06. A customer message on a channel with auto-reply on adds one
    // `ai.auto_reply` job, under an id derived from the message.
    const ai = new Queue(QUEUE_NAMES.ai, { connection: redis });
    registerAutoReplyEventHandlers(
      {
        add: async (payload, jobId) => {
          await ai.add(aiAutoReplyJob.name, payload, { ...aiAutoReplyJob.options, jobId });
        },
      },
      readAutoReplySettings,
    );

    // M5-03. After the content module's own handlers: every help center
    // event drops the brand's cached pages, under its own subscriber name.
    registerPageCacheHandlers(new RedisPageCache(redis));

    // M8-03. `contact.created` is the contacts module's; the webhooks module
    // subscribes to it below. Last, so every other subscriber of a ticket event has run before
    // its deliveries are written. `webhook.delivery_requested` adds the
    // `webhook.deliver` job under the delivery's id, once that row committed.
    registerContactEventHandlers();
    const webhooks = new Queue(QUEUE_NAMES.webhooks, { connection: redis });
    registerWebhookEventHandlers({
      repository: new WebhooksRepository(),
      queue: {
        add: async (payload, jobId) => {
          await webhooks.add(webhookDeliverJob.name, payload, {
            ...webhookDeliverJob.options,
            jobId,
          });
        },
      },
    });

    // M7-07, M7-09. A rule's AI triage and a ready voice note each add a job
    // on the same `ai` queue, under ids derived from the rows, by the rule above.
    registerTriageEventHandlers({
      add: async ({ jobId, name, payload }) => {
        await ai.add(name, payload, { ...aiClassifyJob.options, jobId });
      },
    });
    registerTranscriptionHandlers(
      {
        add: async ({ jobId, payload }) => {
          await ai.add(aiTranscribeJob.name, payload, { ...aiTranscribeJob.options, jobId });
        },
      },
      transcriptionConfigFrom(settings),
    );

    return {
      close: async () => {
        await media.close();
        await knowledge.close();
        await assignment.close();
        await outbound.close();
        await inbound.close();
        await sla.close();
        await rules.close();
        await notify.close();
        await domains.close();
        await webhooks.close();
        await ai.close();
      },
    };
  },
  // Events of one ticket one at a time and in order; different tickets side by
  // side (`@helpdock/jobs` ordering.ts, docs/guides/operations.md).
  createEventWorker: ({ redis, db, log, env }) =>
    createWorker(outboxEventJob, createOutboxEventHandler(), {
      redis,
      db,
      log,
      concurrency: env.OUTBOX_CONCURRENCY ?? DEFAULT_OUTBOX_CONCURRENCY,
      serialize: outboxJobOrderingKeys,
    }),
  createOutboundWorker: ({ redis, db, log, env, installSmtp }) => {
    const keyring = createKeyring(env);
    const emailRepository = new EmailRepository();
    const csatRepository = new CsatRepository();
    const csatTokens = new CsatTokens(keyring);
    const email = createEmailSendProcessor({
      db,
      log,
      repository: emailRepository,
      handler: createEmailSendHandler({
        repository: emailRepository,
        keyring,
        installSmtp,
        transports: smtpTransportFactory,
        surveys: new CsatEmailSource(csatRepository, csatTokens, env.APP_URL),
      }),
    });
    const telegramRepository = new TelegramRepository();
    const telegram = createTelegramSendProcessor({
      db,
      log,
      repository: telegramRepository,
      handler: createTelegramSendHandler({
        db,
        repository: telegramRepository,
        keyring,
        api: telegramApiFactory(env.TELEGRAM_API_ROOT),
        storage: storageFor(env),

        csat: new CsatTelegramNotices({
          repository: csatRepository,
          tokens: csatTokens,
          appUrl: env.APP_URL,
        }),
      }),
    });
    const worker = new Worker(
      QUEUE_NAMES.outbound,
      (job) => (job.name === telegramSendJob.name ? telegram(job) : email(job)),
      { connection: redis },
    );
    worker.on('failed', (job, error) =>
      log.error(
        { job: job?.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
        'outbound job failed',
      ),
    );
    return worker;
  },
  createMediaWorker: ({ redis, db, log, env }) => {
    const storage = storageFor(env);
    const attachments = createJobProcessor(
      mediaProcessJob,
      createMediaProcessor({
        storage,
        tools: createMediaTools({ ffmpeg: env.FFMPEG_PATH, ffprobe: env.FFPROBE_PATH }),
        scanner: scannerFor(env),
      }),
      { db, log },
    );
    // M5-02: article images share the queue and its budget.
    const articleImages = createJobProcessor(
      helpCenterMediaProcessJob,
      createHcMediaProcessor(storage),
      { db, log },
    );
    const worker = new Worker(
      QUEUE_NAMES.media,
      async (job) => {
        if (job.name === helpCenterMediaProcessJob.name) {
          return articleImages(job);
        }
        return attachments(job);
      },
      // One at a time. sharp and ffmpeg are CPU-bound and a worker that runs
      // four conversions at once on a small VPS starves everything else on
      // it; more replicas is the way to scale this, not more concurrency.
      { connection: redis, concurrency: 1 },
    );
    worker.on('failed', (job, error) =>
      log.error(
        { job: job?.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
        'media job failed',
      ),
    );
    return worker;
  },
  createAssignmentWorker: ({ redis, db, log }) => {
    const businessHours = businessHoursService();
    // The timer re-adds itself to its own queue when it fires while the
    // department is closed.
    const deferrals = new Queue(QUEUE_NAMES.assignment, { connection: redis });
    const worker = createWorker(
      assignmentOfflineUnassignJob,
      createOfflineUnassignProcessor({
        ...assignmentReads(redis),
        calendarFor: (tx, brandId, departmentId) =>
          businessHours.calendarFor(brandId, departmentId, tx),
        queue: offlineUnassignQueue(deferrals),
      }),
      { redis, db, log },
    );
    return {
      close: async () => {
        await worker.close();
        await deferrals.close();
      },
    };
  },
  createMaintenanceWorker: ({ redis, db, log, env }) => {
    const maintenance = new Queue(QUEUE_NAMES.maintenance, { connection: redis });
    // M1-14's nightly retention, M8-04's hourly rollup and M8-07's nightly
    // purge tick, each upserted on every boot for the reason above.
    for (const { job, cron } of [
      { job: maintenanceRetentionScheduleJob, cron: RETENTION_CRON },
      { job: statsRollupScheduleJob, cron: STATS_ROLLUP_CRON },
      { job: brandPurgeScheduleJob, cron: BRAND_PURGE_CRON },
    ]) {
      maintenance
        .upsertJobScheduler(
          job.name,
          { pattern: cron, tz: 'UTC' },
          { name: job.name, data: {}, opts: job.options },
        )
        .catch((error: unknown) =>
          log.error({ err: error, job: job.name }, 'could not register a maintenance schedule'),
        );
    }

    const objects = new S3BrandObjects(createS3Client(env), env.S3_BUCKET);
    const storageUsage = new StorageUsageStore(redis);
    const inbound = new Queue(QUEUE_NAMES.inbound, { connection: redis });
    const stats = createStatsProcessor({
      db,
      log,
      storage: { objects, store: storageUsage },
      queue: {
        add: async (payload, jobId) => {
          await maintenance.add(statsRollupJob.name, payload, {
            ...statsRollupJob.options,
            jobId,
          });
        },
      },
    });
    const purge = createBrandPurgeProcessor({
      db,
      log,
      objects,
      redis,
      storageUsage,
      removePollers: async (mailboxIds) => {
        for (const mailboxId of mailboxIds) {
          await inbound.removeJobScheduler(emailPollSchedulerId(mailboxId));
        }
      },
      queue: {
        add: async (payload, jobId) => {
          await maintenance.add(brandPurgeJob.name, payload, {
            ...brandPurgeJob.options,
            jobId,
          });
        },
      },
    });
    const retention = createMaintenanceProcessor({
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
    });

    const worker = new Worker(
      QUEUE_NAMES.maintenance,
      async (job) => {
        await (stats(job) ?? purge(job) ?? retention(job));
      },
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
        await inbound.close();
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
    // M6-01, development only: every bot polled instead of waiting for webhooks.
    const telegramRepository = new TelegramRepository();
    const telegramApi = telegramApiFactory(env.TELEGRAM_API_ROOT);
    if (env.TELEGRAM_POLLING === true) {
      scheduleAllTelegramPollers(db, telegramRepository, queueTelegramPollScheduler(inbound)).catch(
        (error: unknown) => log.error({ err: error }, 'could not register the Telegram pollers'),
      );
    }
    const telegramPoll = createTelegramPollProcessor({
      db,
      log,
      keyring: createKeyring(env),
      repository: telegramRepository,
      api: telegramApi,
      inbound: createTelegramInboundService({
        db,
        storage: storageFor(env),
        log,
        keyring: createKeyring(env),
        api: telegramApi,
      }),
    });

    const worker = new Worker(
      QUEUE_NAMES.inbound,
      async (job) => {
        if (job.name === telegramPollJob.name) {
          await telegramPoll(job);
          return;
        }
        // `form.submit` shares this queue from M4.
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
  createHelpCenterWorker: ({ redis, db, log, env, settings }) => {
    const knowledge = new Queue(QUEUE_NAMES.knowledge, { connection: redis });
    knowledge
      .upsertJobScheduler(
        knowledgeConfigureJob.name,
        { every: 60_000 },
        { name: knowledgeConfigureJob.name, data: {}, opts: knowledgeConfigureJob.options },
      )
      .catch((error: unknown) =>
        log.error({ err: error }, 'could not register the embedding space tick'),
      );
    knowledge
      .upsertJobScheduler(
        helpCenterPublishDueSweepJob.name,
        { every: 3_600_000 },
        {
          name: helpCenterPublishDueSweepJob.name,
          data: {},
          opts: helpCenterPublishDueSweepJob.options,
        },
      )
      .catch((error: unknown) =>
        log.error({ err: error }, 'could not register the help center publish sweep'),
      );
    knowledge
      .upsertJobScheduler(
        helpCenterSearchReindexSweepJob.name,
        { every: 3_600_000 },
        {
          name: helpCenterSearchReindexSweepJob.name,
          data: {},
          opts: helpCenterSearchReindexSweepJob.options,
        },
      )
      .catch((error: unknown) =>
        log.error({ err: error }, 'could not register the help center search sweep'),
      );

    const publishing = createHelpCenterKnowledgeProcessor({
      db,
      log,
      queue: {
        add: async (payload, jobId) => {
          await knowledge.add(helpCenterPublishDueJob.name, payload, {
            ...helpCenterPublishDueJob.options,
            jobId,
          });
        },
      },
    });
    // M5-05's reindex jobs share the queue; anything else goes to M5-01's processor.
    const search = createSearchKnowledgeProcessor({
      db,
      log,
      queue: {
        add: async (payload, jobId) => {
          await knowledge.add(helpCenterSearchReindexJob.name, payload, {
            ...helpCenterSearchReindexJob.options,
            jobId,
          });
        },
      },
    });
    const ai = createAiRuntime({
      db,
      settings,
      http: safeAiTransport(env.OUTBOUND_ALLOW_CIDRS, (event) =>
        log.warn(
          { host: event.host, address: event.address },
          'embeddings endpoint resolves to a blocked address (DOMAIN-RULES §13)',
        ),
      ),
    });
    // M7-02's configure tick and re-embed share the queue too.
    const embedding = createEmbeddingSpaceProcessor({
      db,
      settings,
      log,
      ai,
      queue: {
        add: async (jobId) => {
          await knowledge.add(
            knowledgeReembedJob.name,
            {},
            { ...knowledgeReembedJob.options, jobId },
          );
        },
      },
    });
    // M7-03's source syncs and embeds, and every source's schedule re-registered on boot.
    const queues = knowledgeQueuesOf(knowledge);
    scheduleAllKnowledgeSources(db, queues).catch((error: unknown) =>
      log.error({ err: error }, 'could not register the knowledge sync schedules'),
    );
    const sync = createKnowledgeSyncProcessor({
      db,
      ai,
      log,
      loaders: knowledgeLoaders(env, settings, log),
    });
    const worker = new Worker(
      QUEUE_NAMES.knowledge,
      async (job) => {
        await (sync(job) ?? embedding(job) ?? search(job) ?? publishing(job));
      },
      // A crawl takes minutes; a few at once keeps one from holding up a
      // scheduled publish behind it.
      { connection: redis, concurrency: 4 },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'knowledge job failed'),
    );

    return {
      close: async () => {
        await worker.close();
        await knowledge.close();
      },
    };
  },
  createNotifyWorker: ({ redis, db, log, env, settings }) => {
    const channels = new InstallChannels(settings);
    const notify = createNotifyProcessor(
      {
        repository: new NotificationsRepository(),
        settings: channels,
        push: new WebPushSender({ subject: env.APP_URL, allowCidrs: env.OUTBOUND_ALLOW_CIDRS }),
        appUrl: env.APP_URL,
      },
      { db, log },
    );
    const authEmail = createAuthEmailProcessor(
      { senders: channels, keyring: createKeyring(env) },
      { db, log },
    );
    const worker = new Worker(
      QUEUE_NAMES.notify,
      (job) => (job.name === authEmailJob.name ? authEmail(job) : notify(job)),
      { connection: redis },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'notify job failed'),
    );

    return { close: () => worker.close() };
  },
  createDomainsWorker: ({ redis, db, log, env }) => {
    const queue = new Queue(QUEUE_NAMES.domains, { connection: redis });
    queue
      .upsertJobScheduler(
        domainVerifyScheduleJob.name,
        { pattern: DOMAIN_VERIFY_CRON, tz: 'UTC' },
        { name: domainVerifyScheduleJob.name, data: {}, opts: domainVerifyScheduleJob.options },
      )
      .catch((error: unknown) =>
        log.error({ err: error }, 'could not register the custom-domain check schedule'),
      );

    const verifier = new DomainVerifier({
      db,
      log,
      repository: new DomainsRepository(),
      cnameTarget: cnameTargetOf(env),
      probes: createDomainProbes({
        allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
        onBlocked: (event) =>
          log.warn(
            { host: event.host, address: event.address },
            'custom domain resolves to a blocked address (DOMAIN-RULES §13)',
          ),
      }),
    });
    const worker = new Worker(
      QUEUE_NAMES.domains,
      createDomainsProcessor({ db, verifier, queue: domainsQueueOf(queue), log }),
      // A few at once: each check is mostly waiting on a name server or a handshake.
      { connection: redis, concurrency: 4 },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'domains job failed'),
    );

    return {
      close: async () => {
        await worker.close();
        await queue.close();
      },
    };
  },
  createAiWorker: ({ redis, db, log, env, settings, installSmtp }) => {
    const ai = createAiRuntime({
      db,
      settings,
      http: safeAiTransport(env.OUTBOUND_ALLOW_CIDRS, (event) =>
        log.warn(
          { host: event.host, address: event.address },
          'embeddings endpoint resolves to a blocked address (DOMAIN-RULES §13)',
        ),
      ),
    });
    const autoReply = createAutoReplyProcessor(createAutoReplyDeps({ db, ai, installSmtp, log }));
    const triage = createTriageProcessor({ db, ai, rules: createRulesEngineDeps({ log }), log });
    const transcribe = createTranscribeProcessor({
      db,
      ai,
      storage: storageFor(env),
      config: transcriptionConfigFrom(settings),
      log,
    });
    const worker = new Worker(
      QUEUE_NAMES.ai,
      async (job) => {
        const run = autoReply(job) ?? triage(job) ?? transcribe(job);
        if (run === null) {
          throw new UnrecoverableError(`No consumer for ${job.name} on the ai queue`);
        }
        await run;
      },
      // A few at once: each answer is mostly waiting on a model.
      { connection: redis, concurrency: 4 },
    );
    worker.on('failed', (job, error) =>
      log.error({ job: job?.name, jobId: job?.id, err: error }, 'ai job failed'),
    );
    return worker;
  },
  createWebhooksWorker: ({ redis, db, log, env }) => {
    const worker = new Worker(
      QUEUE_NAMES.webhooks,
      createWebhookDeliverProcessor({
        db,
        log,
        repository: new WebhooksRepository(),
        keyring: createKeyring(env),
        policy: {
          allowCidrs: env.OUTBOUND_ALLOW_CIDRS,
          onBlocked: (event) =>
            log.warn(
              { host: event.host, address: event.address, reason: event.reason },
              'webhook destination blocked (DOMAIN-RULES §13)',
            ),
        },
      }),
      // A few at once: each delivery is mostly waiting on somebody's server.
      { connection: redis, concurrency: 5 },
    );
    worker.on('failed', (job, error) =>
      log.warn(
        { job: job?.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
        'webhook.deliver attempt failed',
      ),
    );
    return worker;
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
  const worker = deps.createEventWorker({ redis: connection, db, log, env });
  const outbound = deps.createOutboundWorker({ redis: connection, db, log, env, installSmtp });
  const media = deps.createMediaWorker({ redis: connection, db, log, env });
  const assignment = deps.createAssignmentWorker({ redis: connection, db, log });
  const maintenance = deps.createMaintenanceWorker({ redis: connection, db, log, env });
  const inbound = deps.createInboundWorker({ redis: connection, db, log, env });
  const sla = deps.createSlaWorker({ redis: connection, db, log });
  const rules = deps.createRulesWorker({ redis: connection, db, log });
  const helpCenter = deps.createHelpCenterWorker({ redis: connection, db, log, env, settings });
  const notify = deps.createNotifyWorker({ redis: connection, db, log, env, settings });
  const domains = deps.createDomainsWorker({ redis: connection, db, log, env });
  const webhooks = deps.createWebhooksWorker({ redis: connection, db, log, env });
  const ai = deps.createAiWorker({ redis: connection, db, log, env, settings, installSmtp });
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
    await outbound.close();
    // After the event worker, because that is what adds media jobs: closing the
    // media worker first would leave a job queued with nothing draining it,
    // which is harmless but slower to notice than the other order's bug.
    await media.close();
    await assignment.close();
    await maintenance.close();
    await inbound.close();
    await sla.close();
    await rules.close();
    await helpCenter.close();
    await notify.close();
    await domains.close();
    await webhooks.close();
    await ai.close();
    await producers.close();
    await connection.quit();
  };

  return {
    // Idempotent, so a handler wired to both SIGTERM and SIGINT is safe.
    close: () => (closing ??= shutDown()),
  };
};
