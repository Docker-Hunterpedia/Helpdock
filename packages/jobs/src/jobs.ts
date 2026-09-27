import type { JobsOptions } from 'bullmq';
import { z } from 'zod';
import { QUEUE_NAMES, type QueueName } from './queues.js';
import { parsePayload } from './validation.js';

/**
 * The job registry. A job is a name, the queue it runs on, a Zod schema for its
 * payload and the retry profile it is added with. Nothing enqueues or consumes a
 * job without going through a definition, so the payload is validated on the way
 * in and on the way out and the two can never disagree (AGENTS.md, validation at
 * every boundary).
 *
 * M0 defined three: the relay itself, the fan-out job it publishes, and the
 * nightly retention job of DOMAIN-RULES §11. Later milestones add the rest of
 * ARCHITECTURE §13 beside them: M1-10 the media pipeline, M1-14 the nightly
 * tick that fans retention out per brand.
 */

/** How a repeatable job recurs. BullMQ turns either form into a job scheduler. */
export type JobSchedule = { readonly everyMs: number } | { readonly cron: string };

export interface JobDefinition<TName extends string = string, TPayload = unknown> {
  /** Dotted, unique across every queue. It is the BullMQ job name. */
  readonly name: TName;
  readonly queue: QueueName;
  readonly schema: z.ZodType<TPayload>;
  /** Attempts and backoff the job is added with, unless a caller overrides them. */
  readonly options: JobsOptions;
  /** Set on repeatable and cron jobs; absent on jobs that are enqueued by hand. */
  readonly schedule?: JobSchedule;
  /**
   * The natural key a consumer dedupes on (DOMAIN-RULES §6). Left out when the
   * job has none, in which case {@link idempotencyKeyFor} falls back to the
   * BullMQ job id.
   */
  readonly idempotencyKey?: (payload: TPayload) => string;
}

/** A payload that names its brand, which every consumer needs (DOMAIN-RULES §1.4). */
export interface BrandScopedPayload {
  readonly brandId: string;
}

/**
 * Parses `data` against a definition, or throws a
 * {@link ./validation.js PayloadValidationError}. Called on enqueue, where a bad
 * payload is a caller bug, and on consume, where the consumer turns it into a
 * BullMQ `UnrecoverableError`: a payload that is wrong now will still be wrong
 * on the next attempt, so retrying it only delays the failure.
 */
export const parseJobPayload = <TName extends string, TPayload>(
  definition: JobDefinition<TName, TPayload>,
  data: unknown,
): TPayload => parsePayload(`payload for job ${definition.name}`, definition.schema, data);

/**
 * The `job_receipts` key a delivery of this job claims. A definition with a
 * natural key wins; otherwise the BullMQ job id stands in, which is enough
 * because a redelivery of the same job carries the same id.
 */
export const idempotencyKeyFor = <TName extends string, TPayload>(
  definition: JobDefinition<TName, TPayload>,
  payload: TPayload,
  jobId: string,
): string => definition.idempotencyKey?.(payload) ?? `${definition.name}:${jobId}`;

const defineJob = <TName extends string, TPayload>(definition: {
  readonly name: TName;
  readonly queue: QueueName;
  readonly schema: z.ZodType<TPayload>;
  readonly options: JobsOptions;
  readonly schedule?: JobSchedule;
  readonly idempotencyKey?: (payload: TPayload) => string;
}): JobDefinition<TName, TPayload> => Object.freeze({ ...definition });

/**
 * Dotted lower-case segments, as in `ticket.replied`. Event names reach the
 * dispatcher from the database, so their shape is checked rather than assumed.
 */
export const OUTBOX_EVENT_NAME = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'must be dotted lower-case segments, for example ticket.replied',
  );

/** Cadence of the relay poll in ARCHITECTURE §13, and the default of `startOutboxRelay`. */
export const OUTBOX_RELAY_INTERVAL_MS = 500;

/** Days after which a published outbox row or a completed receipt is purged (DOMAIN-RULES §11). */
export const RETENTION_DAYS = 7;

/**
 * The relay of DOMAIN-RULES §6. It carries no payload: the table is the input.
 * The schedule states the cadence ARCHITECTURE §13 fixes, and
 * `startOutboxRelay` polls at it — the loop lives in the worker process rather
 * than in a BullMQ job because `LISTEN outbox` needs a connection of its own,
 * which a job that starts and ends cannot hold.
 */
export const outboxRelayJob = defineJob({
  name: 'outbox.relay',
  queue: QUEUE_NAMES.outbox,
  schema: z.object({}),
  options: { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
  schedule: { everyMs: OUTBOX_RELAY_INTERVAL_MS },
});

export const outboxEventPayloadSchema = z.object({
  /** The `outbox` row this job was published from. Also the BullMQ job id. */
  outboxId: z.uuid(),
  brandId: z.uuid(),
  event: OUTBOX_EVENT_NAME,
  payload: z.record(z.string(), z.unknown()),
});

export type OutboxEventPayload = z.infer<typeof outboxEventPayloadSchema>;

/**
 * The fan-out job the relay publishes, one per outbox row. The dispatcher looks
 * up a handler by `event`, so a new side effect is a new handler rather than a
 * new queue. Attempts and backoff follow the outbound profile of ARCHITECTURE
 * §13; a job that exhausts them stays in the failed set for the DLQ view.
 */
export const outboxEventJob = defineJob({
  name: 'outbox.event',
  queue: QUEUE_NAMES.outbox,
  schema: outboxEventPayloadSchema,
  options: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    // BullMQ ignores an `add` whose job id already exists, but only while that
    // job is still in Redis. Keeping completed jobs for a day keeps the relay's
    // crash window covered; `job_receipts` is what makes the guarantee hold
    // beyond it.
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) => `outbox.event:${payload.outboxId}`,
});

export const maintenanceRetentionPayloadSchema = z.object({
  brandId: z.uuid(),
  /**
   * The night this run belongs to, as `YYYY-MM-DD` in UTC. The job id is built
   * from it ({@link retentionJobId}), so a scheduler tick that fires twice in
   * one night adds one job per brand, not two.
   */
  runDate: z.iso.date(),
});

export type MaintenanceRetentionPayload = z.infer<typeof maintenanceRetentionPayloadSchema>;

/**
 * Nightly retention for **one** brand (DOMAIN-RULES §11, M1-14). It carries no
 * schedule of its own: {@link maintenanceRetentionScheduleJob} adds one per
 * brand, because a job that needs several brands enqueues one child job per
 * brand rather than widening its tenant context (DOMAIN-RULES §1.4).
 *
 * The consumer is `apps/api/src/retention/retention.job.ts`. It runs each batch
 * in a transaction of its own instead of one receipt-claiming transaction, so a
 * brand with a million expired rows never holds a lock for the whole purge.
 * That is also why it needs no receipt: every purge is "delete what is older
 * than the cutoff", and a retry of a half-finished run simply finds fewer rows.
 */
export const maintenanceRetentionJob = defineJob({
  name: 'maintenance.retention',
  queue: QUEUE_NAMES.maintenance,
  schema: maintenanceRetentionPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 7 * 86_400, count: 1_000 },
    removeOnFail: false,
  },
});

/**
 * The BullMQ job id of one brand's run on one night; see
 * {@link maintenanceRetentionPayloadSchema}. Dots, not colons: BullMQ refuses a
 * custom id with a colon in it, because it uses them to separate key segments.
 */
export const retentionJobId = ({ brandId, runDate }: MaintenanceRetentionPayload): string =>
  `maintenance.retention.${brandId}.${runDate}`;

/** 03:00 UTC every night. */
export const RETENTION_CRON = '0 3 * * *';

/**
 * The nightly tick (M1-14): adds one {@link maintenanceRetentionJob} per active
 * brand, then purges `job_receipts`, which is global and so belongs to no
 * brand's run.
 */
export const maintenanceRetentionScheduleJob = defineJob({
  name: 'maintenance.retention.schedule',
  queue: QUEUE_NAMES.maintenance,
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnFail: 100 },
  schedule: { cron: RETENTION_CRON },
});

export const mediaProcessPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The row the whole job is about, and the key every delivery dedupes on. */
  attachmentId: z.uuid(),
});

export type MediaProcessPayload = z.infer<typeof mediaProcessPayloadSchema>;

/**
 * The media pipeline's one job (ARCHITECTURE §9, §13): sniff the uploaded
 * object's magic bytes, re-encode or transcode it, scan it, and leave the row
 * `ready` or `rejected`.
 *
 * It is a queue of its own rather than an outbox handler because the work is
 * measured in seconds of CPU — sharp and ffmpeg — and the `outbox` queue is the
 * path every other side effect in the install shares. What *does* go through
 * the outbox is the request for it: `attachment.uploaded` is written in the
 * same transaction as the confirm, and its handler adds this job with
 * `jobId = attachmentId`, so a confirm that rolls back never queues anything and
 * a redelivered event never queues twice (DOMAIN-RULES §6).
 *
 * Three attempts, spaced widely: the failures worth retrying are a bucket that
 * blinked, not bytes that will decode differently next time. Anything the
 * pipeline judges — a MIME that does not match the magic bytes, an image that
 * will not decode — marks the row `rejected` and *returns*, because retrying a
 * verdict only delays it.
 */
export const mediaProcessJob = defineJob({
  name: 'media.process',
  queue: QUEUE_NAMES.media,
  schema: mediaProcessPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) => `media.process:${payload.attachmentId}`,
});

export const assignmentOfflineUnassignPayloadSchema = z.object({
  brandId: z.uuid(),
  userId: z.uuid(),
  departmentId: z.uuid(),
  /** When presence noticed they went offline; the timer counts from here. */
  since: z.iso.datetime(),
});

export type AssignmentOfflineUnassignPayload = z.infer<
  typeof assignmentOfflineUnassignPayloadSchema
>;

/**
 * M1-07's auto-unassign timer (DOMAIN-RULES §12): added with a delay of the
 * department's minutes when somebody goes offline, and a no-op when it fires
 * if they came back — or went offline again later, in which case the later
 * job is the one that counts.
 *
 * Keyed by the departure, not the job id, so the same departure is acted on
 * once however it is redelivered, and a second departure is a second key.
 */
export const assignmentOfflineUnassignJob = defineJob({
  name: 'assignment.offline_unassign',
  queue: QUEUE_NAMES.assignment,
  schema: assignmentOfflineUnassignPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) =>
    `assignment.offline_unassign:${payload.userId}:${payload.departmentId}:${payload.since}`,
});

export const emailSendPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The `email_deliveries` row: the whole job is about it, and it is the natural key. */
  deliveryId: z.uuid(),
});

export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>;

/** Attempts per round before a send is dead-lettered (M2-05). */
export const EMAIL_SEND_JOB_ATTEMPTS = 5;

/**
 * M2-05's outbound email (ARCHITECTURE §13, `outbound` queue). The request for
 * it goes through the outbox — the `email.send` event, written beside the
 * `email_deliveries` row in the transaction of the reply or the inbound mail —
 * and that event's handler adds this job, as `attachment.uploaded` adds
 * `media.process`.
 *
 * **Idempotent by delivery** (DOMAIN-RULES §6): the receipt key is the
 * delivery id, claimed in the transaction that marks the row sent, so a second
 * delivery of the job finds the receipt and sends nothing. The consumer also
 * skips a row that is already `sent`, which holds after receipts are purged.
 *
 * Five attempts over about eight minutes; a send that exhausts them stays in
 * the failed set — the dead-letter queue — and its row becomes `failed`, which
 * is what Channels › Outgoing email › Failed sends lists.
 */
export const emailSendJob = defineJob({
  name: 'email.send',
  queue: QUEUE_NAMES.outbound,
  schema: emailSendPayloadSchema,
  options: {
    attempts: EMAIL_SEND_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) => `email.send:${payload.deliveryId}`,
});

export const emailPollPayloadSchema = z.object({
  brandId: z.uuid(),
  mailboxId: z.uuid(),
});

export type EmailPollPayload = z.infer<typeof emailPollPayloadSchema>;

/**
 * M2-02: one IMAP mailbox, polled (ARCHITECTURE §13: "`email.poll` (per
 * mailbox, repeatable)"). One BullMQ job scheduler per mailbox, every
 * `poll_interval_seconds`, id {@link emailPollSchedulerId}; the worker
 * upserts them on boot and whenever `mailbox.changed` says a mailbox was
 * created, edited or deleted (DOMAIN-RULES §10: "repeatable pollers are
 * re-registered on worker boot").
 *
 * One attempt and no receipt: the next tick *is* the retry, and a poll is
 * idempotent without one because each message dedupes by its `Message-ID`
 * (DOMAIN-RULES §6). A receipt per tick would be a row per mailbox per minute.
 */
export const emailPollJob = defineJob({
  name: 'email.poll',
  queue: QUEUE_NAMES.inbound,
  schema: emailPollPayloadSchema,
  options: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { age: 7 * 86_400, count: 1_000 },
  },
});

/** The scheduler id of one mailbox's poller. Dots, not colons, for the reason {@link retentionJobId} gives. */
export const emailPollSchedulerId = (mailboxId: string): string => `email.poll.${mailboxId}`;

export const slaTimerPayloadSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  clock: z.enum(['first_response', 'next_response', 'resolution']),
  /** The share of the target this timer fires at; 100 is the breach. */
  stepPercent: z.int().positive(),
});

export type SlaTimerPayload = z.infer<typeof slaTimerPayloadSchema>;

/**
 * One SLA timer (M3-02, DOMAIN-RULES §3.4): an escalation step, or the breach
 * at 100 %, of one clock of one ticket. Added with a delay by the
 * `sla.schedule` outbox handler, never by a request.
 *
 * The job id is {@link slaTimerJobId}, one per ticket, clock and step, so
 * re-adding a timer that already exists moves it rather than duplicating it.
 * It has no receipt: the clock row records the steps that fired, which is the
 * natural key, and a timer that fires early — its clock was paused, or its
 * target raised, after it was added — moves itself back rather than doing
 * anything, which a receipt claimed on that first delivery would forbid.
 */
export const slaTimerJob = defineJob({
  name: 'sla.timer',
  queue: QUEUE_NAMES.sla,
  schema: slaTimerPayloadSchema,
  options: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    // Removed as soon as it completes, so the same id can be added again when
    // a reopen starts the same clock over.
    removeOnComplete: true,
    removeOnFail: { age: 7 * 86_400 },
  },
});

/**
 * `sla:<ticket_id>:<clock>:<step>` of DOMAIN-RULES §3.4, spelled with dots:
 * BullMQ refuses a custom id with a colon in it (see {@link retentionJobId}).
 */
export const slaTimerJobId = ({
  ticketId,
  clock,
  stepPercent,
}: Pick<SlaTimerPayload, 'ticketId' | 'clock' | 'stepPercent'>): string =>
  `sla.${ticketId}.${clock}.${String(stepPercent)}`;

export const slaRebuildPayloadSchema = z.object({
  /** Absent on the boot tick, which adds one job per brand; present on those. */
  brandId: z.uuid().optional(),
});

export type SlaRebuildPayload = z.infer<typeof slaRebuildPayloadSchema>;

/**
 * `sla.rebuild` (DOMAIN-RULES §3.4, §10): on worker boot, and hourly after, it
 * re-creates every timer of every running clock, which is what protects the
 * SLA against losing Redis. Runs on the `sla` queue beside the timers it
 * rebuilds; a tick without a brand fans out one job per brand, as retention
 * does, rather than widening a tenant context (DOMAIN-RULES §1.4).
 */
export const slaRebuildJob = defineJob({
  name: 'sla.rebuild',
  queue: QUEUE_NAMES.sla,
  schema: slaRebuildPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 7 * 86_400 },
  },
  schedule: { everyMs: 3_600_000 },
});

/** A rule chain carries at most this many rule ids; see `RULE_MAX_DEPTH` in `@helpdock/schemas`. */
const RULE_CHAIN_MAX = 3;

export const rulesEvaluatePayloadSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  /** The rule events this domain event stands for, e.g. `ticket_updated` and `assigned`. */
  triggers: z
    .array(z.string().regex(/^[a-z_]+$/))
    .min(1)
    .max(10),
  /** The outbox row the event came from. Also what the job id and the receipt are built from. */
  sourceOutboxId: z.uuid(),
  /**
   * The rules whose actions led to this event, oldest first: empty when a
   * person, a channel or a timer started it. Its length is the depth the
   * guard counts from (REQUIREMENTS §4.3).
   */
  chain: z.array(z.uuid()).max(RULE_CHAIN_MAX),
});

export type RulesEvaluatePayload = z.infer<typeof rulesEvaluatePayloadSchema>;

/**
 * M3-03: evaluate a brand's event rules for one ticket after one domain event.
 *
 * Rules run from the outbox relay's domain events, never from a request: the
 * rules module registers an `outbox.event` handler for the ticket, SLA and
 * CSAT events, and that handler adds this job with a job id derived from the
 * outbox row (as `attachment.uploaded` does for `media.process`), so a
 * redelivered event adds nothing new and a failing rule never holds up the
 * socket frame the same event carries. Keyed by the outbox row, so one event
 * is evaluated once.
 */
export const rulesEvaluateJob = defineJob({
  name: 'rules.evaluate',
  queue: QUEUE_NAMES.rules,
  schema: rulesEvaluatePayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) => `rules.evaluate:${payload.sourceOutboxId}`,
});

/** The BullMQ job id of the evaluation one outbox row asks for. */
export const rulesEvaluateJobId = ({ sourceOutboxId }: RulesEvaluatePayload): string =>
  `rules.evaluate.${sourceOutboxId}`;

export const rulesTimeBasedPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The tick this run belongs to, as an ISO instant rounded down to the tick. */
  tick: z.iso.datetime(),
});

export type RulesTimeBasedPayload = z.infer<typeof rulesTimeBasedPayloadSchema>;

/**
 * M3-04: one brand's time-based rules, for one tick. Added by
 * {@link rulesTimeBasedScheduleJob}, one per brand, because a job that needs
 * several brands enqueues one child per brand (DOMAIN-RULES §1.4).
 */
export const rulesTimeBasedJob = defineJob({
  name: 'rules.time_based',
  queue: QUEUE_NAMES.rules,
  schema: rulesTimeBasedPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 5_000 },
    removeOnFail: 1_000,
  },
  idempotencyKey: (payload) => `rules.time_based:${payload.brandId}:${payload.tick}`,
});

/** The BullMQ job id of one brand's run for one tick. Dots, because BullMQ refuses colons. */
export const rulesTimeBasedJobId = ({ brandId, tick }: RulesTimeBasedPayload): string =>
  `rules.time_based.${brandId}.${Date.parse(tick)}`;

/** Every five minutes: the shortest interval a rule may ask for is fifteen. */
export const RULES_TIME_BASED_CRON = '*/5 * * * *';

/** The cron tick that fans {@link rulesTimeBasedJob} out per brand (M3-04). */
export const rulesTimeBasedScheduleJob = defineJob({
  name: 'rules.time_based.schedule',
  queue: QUEUE_NAMES.rules,
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnFail: 100 },
  schedule: { cron: RULES_TIME_BASED_CRON },
});

export const notifyEmailPayloadSchema = z.object({
  brandId: z.uuid(),
  notificationId: z.uuid(),
});
export type NotifyEmailPayload = z.infer<typeof notifyEmailPayloadSchema>;

/**
 * M3-07: one staff notification email, from the install's system sender.
 * Added by the `notification.created` handler after the notification row has
 * committed, with a job id derived from the row, so a redelivered event adds
 * nothing (DOMAIN-RULES §6). Keyed by the notification: one email per
 * notification however often the job runs.
 */
export const notifyEmailJob = defineJob({
  name: 'notify.email',
  queue: QUEUE_NAMES.notify,
  schema: notifyEmailPayloadSchema,
  options: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) => `notify.email:${payload.notificationId}`,
});

export const notifyPushPayloadSchema = z
  .object({
    brandId: z.uuid(),
    subscriptionId: z.uuid(),
    /** The notification to push. Absent on a test push. */
    notificationId: z.uuid().optional(),
    /** The outbox row of a "Send a test" press. Absent on a real push. */
    testId: z.uuid().optional(),
  })
  .refine((payload) => (payload.notificationId === undefined) !== (payload.testId === undefined), {
    message: 'must name exactly one of notificationId and testId',
  });
export type NotifyPushPayload = z.infer<typeof notifyPushPayloadSchema>;

/**
 * M3-07: one web push to one browser (ADR 0002). One job per subscription, so
 * a dead browser's `410` fails nothing but itself, and "one push per browser"
 * is the idempotency key rather than a hope.
 */
export const notifyPushJob = defineJob({
  name: 'notify.push',
  queue: QUEUE_NAMES.notify,
  schema: notifyPushPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) =>
    `notify.push:${payload.subscriptionId}:${payload.notificationId ?? payload.testId}`,
});

export const domainVerifyPayloadSchema = z.object({
  brandId: z.uuid(),
  /**
   * The one domain to check now, whatever its schedule says: an Admin added
   * it, pressed "Check now" or changed its Cloudflare flag. Absent on the
   * scheduled run, which checks every domain of the brand that is due.
   */
  domainId: z.uuid().optional(),
});
export type DomainVerifyPayload = z.infer<typeof domainVerifyPayloadSchema>;

/**
 * M5-07: check a brand's custom help center domains — the CNAME, the TXT
 * record, where the name points, and a TLS handshake once DNS is verified.
 *
 * A check requested by a person goes through the outbox
 * (`domain.check_requested`), whose handler adds this job with an id derived
 * from the outbox row, so a redelivered event adds nothing (DOMAIN-RULES §6).
 * The periodic re-check is {@link domainVerifyScheduleJob}, which adds one job
 * per brand.
 *
 * No receipt: a check reads DNS and writes what it saw, so running it twice is
 * two observations, not two side effects. One retry, because the failures worth
 * retrying are the database blinking; a DNS timeout is recorded, not thrown.
 */
export const domainVerifyJob = defineJob({
  name: 'domain.verify',
  queue: QUEUE_NAMES.domains,
  schema: domainVerifyPayloadSchema,
  options: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 7 * 86_400, count: 1_000 },
  },
});

/**
 * The job id of one requested check, or of one brand's run for one tick.
 * Dots, because BullMQ refuses colons (see {@link retentionJobId}).
 */
export const domainVerifyJobId = (
  payload: DomainVerifyPayload,
  source: { readonly outboxId: string } | { readonly tick: Date },
): string =>
  'outboxId' in source
    ? `domain.verify.${source.outboxId}`
    : `domain.verify.${payload.brandId}.${String(source.tick.getTime())}`;

/** Every fifteen minutes: the shortest re-check interval a pending domain has. */
export const DOMAIN_VERIFY_CRON = '*/15 * * * *';

/** The tick that adds one {@link domainVerifyJob} per brand (M5-07). */
export const domainVerifyScheduleJob = defineJob({
  name: 'domain.verify.schedule',
  queue: QUEUE_NAMES.domains,
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnFail: 100 },
  schedule: { cron: DOMAIN_VERIFY_CRON },
});

/** Every job defined so far, by name. Bull Board and the metrics reader iterate it. */
export const JOB_DEFINITIONS = Object.freeze({
  [outboxRelayJob.name]: outboxRelayJob,
  [outboxEventJob.name]: outboxEventJob,
  [maintenanceRetentionJob.name]: maintenanceRetentionJob,
  [maintenanceRetentionScheduleJob.name]: maintenanceRetentionScheduleJob,
  [mediaProcessJob.name]: mediaProcessJob,
  [assignmentOfflineUnassignJob.name]: assignmentOfflineUnassignJob,
  [emailSendJob.name]: emailSendJob,
  [emailPollJob.name]: emailPollJob,
  [slaTimerJob.name]: slaTimerJob,
  [slaRebuildJob.name]: slaRebuildJob,
  [rulesEvaluateJob.name]: rulesEvaluateJob,
  [rulesTimeBasedJob.name]: rulesTimeBasedJob,
  [rulesTimeBasedScheduleJob.name]: rulesTimeBasedScheduleJob,
  [notifyEmailJob.name]: notifyEmailJob,
  [notifyPushJob.name]: notifyPushJob,
  [domainVerifyJob.name]: domainVerifyJob,
  [domainVerifyScheduleJob.name]: domainVerifyScheduleJob,
} as const);

export type JobName = keyof typeof JOB_DEFINITIONS;
