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
  /**
   * Set when the timer fired while the department was closed and was put off
   * to its next opening (DOMAIN-RULES §12). Part of the key, so the deferred
   * run is a delivery of its own rather than a duplicate of the first.
   */
  deferredTo: z.iso.datetime().optional(),
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
    `assignment.offline_unassign:${payload.userId}:${payload.departmentId}:${payload.since}` +
    (payload.deferredTo === undefined ? '' : `:${payload.deferredTo}`),
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

export const AUTH_EMAIL_KINDS = ['magicLink', 'passwordReset', 'invite', 'securityChange'] as const;

export const authEmailPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The `auth.email_requested` outbox row. The job id and the receipt are built from it. */
  sourceOutboxId: z.uuid(),
  kind: z.enum(AUTH_EMAIL_KINDS),
  /** The recipient. Address, name and language are read from the row when the job runs. */
  userId: z.uuid(),
  /**
   * The link, sealed with AES-256-GCM under `APP_MASTER_KEY`. It is a working
   * credential, so neither the outbox row nor this job's data in Redis ever
   * holds it in the clear.
   */
  urlEncrypted: z.string().min(1),
  /**
   * How long the link lasts, in the unit the kind's catalog key counts in.
   * Absent for a `securityChange`, whose link is to a page and does not expire.
   */
  expiresIn: z.int().positive().optional(),
  /** Extra interpolation the invite's sentences need: inviter, brand and role. */
  values: z.record(z.string(), z.string()).optional(),
});
export type AuthEmailPayload = z.infer<typeof authEmailPayloadSchema>;

/**
 * A sign-in link, a password reset, a staff invitation or a notice that a
 * credential changed, sent from the
 * install's system sender in the recipient's language. Added by the
 * `auth.email_requested` outbox handler with a job id derived from the outbox
 * row, so a redelivered event adds nothing, and keyed by that row, so one
 * request is one email however often the job runs (DOMAIN-RULES §6).
 *
 * Few attempts, close together: a sign-in link lives ten minutes, and an email
 * that arrives after it has expired is worse than one that never came.
 */
export const authEmailJob = defineJob({
  name: 'auth.email',
  queue: QUEUE_NAMES.notify,
  schema: authEmailPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) => `auth.email:${payload.sourceOutboxId}`,
});

/** The BullMQ job id of the email one outbox row asks for. Dots, because BullMQ refuses colons. */
export const authEmailJobId = (sourceOutboxId: string): string => `auth.email.${sourceOutboxId}`;

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

export const helpCenterPublishDuePayloadSchema = z.object({
  brandId: z.uuid(),
  /**
   * The instant this run is for: a version's `scheduled_at`, or the hour of
   * the sweep. The job id and the receipt are built from it.
   */
  tick: z.iso.datetime(),
});
export type HelpCenterPublishDuePayload = z.infer<typeof helpCenterPublishDuePayloadSchema>;

/**
 * M5-01's scheduled publish for **one** brand: every article version whose
 * `scheduled_at` has passed is published, with its outbox event, in the job's
 * transaction.
 *
 * Added two ways, the shape `sla.timer` and `sla.rebuild` already have: as a
 * **delayed** job for the scheduled instant, by the handler of the
 * `help_center.article_changed` event that scheduling writes, so an article
 * goes live on its minute; and by {@link helpCenterPublishDueSweepJob} every
 * hour for every brand, so a Redis that lost the delayed job still publishes
 * within the hour (DOMAIN-RULES §10). Keyed by brand and tick, and idempotent
 * without the key anyway: a version already published is no longer
 * `scheduled`, so a second run finds nothing.
 */
export const helpCenterPublishDueJob = defineJob({
  name: 'help_center.publish_due',
  queue: QUEUE_NAMES.knowledge,
  schema: helpCenterPublishDuePayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 86_400, count: 5_000 },
    removeOnFail: 1_000,
  },
  idempotencyKey: (payload) => `help_center.publish_due:${payload.brandId}:${payload.tick}`,
});

/** The BullMQ job id of one brand's run for one tick. Dots, because BullMQ refuses colons. */
export const helpCenterPublishDueJobId = ({ brandId, tick }: HelpCenterPublishDuePayload): string =>
  `help_center.publish_due.${brandId}.${Date.parse(tick)}`;

/** The hourly safety net that fans {@link helpCenterPublishDueJob} out per brand. */
export const helpCenterPublishDueSweepJob = defineJob({
  name: 'help_center.publish_due.sweep',
  queue: QUEUE_NAMES.knowledge,
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnFail: 100 },
  schedule: { everyMs: 3_600_000 },
});

export const helpCenterSearchReindexPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The hour of the sweep that added it; the job id and the receipt are built from it. */
  tick: z.iso.datetime(),
});
export type HelpCenterSearchReindexPayload = z.infer<typeof helpCenterSearchReindexPayloadSchema>;

/**
 * M5-05: brings **one** brand's search index in line with its published
 * articles — a row for every published version whose text changed since it
 * was indexed, none for a version that is no longer published.
 *
 * The events keep the index current within seconds (the `search` subscriber
 * of `help_center.*`, in the event's own transaction); this is the safety net
 * behind them, and what fills the index on an install that had published
 * articles before search existed. Added hourly per active brand by
 * {@link helpCenterSearchReindexSweepJob}. Idempotent by construction: a row
 * already current is skipped.
 */
export const helpCenterSearchReindexJob = defineJob({
  name: 'help_center.search_reindex',
  queue: QUEUE_NAMES.knowledge,
  schema: helpCenterSearchReindexPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 86_400, count: 5_000 },
    removeOnFail: 1_000,
  },
  idempotencyKey: (payload) => `help_center.search_reindex:${payload.brandId}:${payload.tick}`,
});

/** The BullMQ job id of one brand's reindex for one sweep. */
export const helpCenterSearchReindexJobId = ({
  brandId,
  tick,
}: HelpCenterSearchReindexPayload): string =>
  `help_center.search_reindex.${brandId}.${Date.parse(tick)}`;

/** The hourly sweep that fans {@link helpCenterSearchReindexJob} out per brand. */
export const helpCenterSearchReindexSweepJob = defineJob({
  name: 'help_center.search_reindex.sweep',
  queue: QUEUE_NAMES.knowledge,
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnFail: 100 },
  schedule: { everyMs: 3_600_000 },
});

export const helpCenterMediaProcessPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The `hc_media` row, and the key every delivery dedupes on. */
  mediaId: z.uuid(),
});
export type HelpCenterMediaProcessPayload = z.infer<typeof helpCenterMediaProcessPayloadSchema>;

/**
 * M5-02: an article image through the media pipeline of ARCHITECTURE §9 —
 * sniff the magic bytes, re-encode to WebP with sharp, strip metadata. Added
 * by the `help_center.media_uploaded` outbox handler after the confirm
 * committed, with `jobId = mediaId`, as `media.process` is for attachments.
 */
export const helpCenterMediaProcessJob = defineJob({
  name: 'help_center.media_process',
  queue: QUEUE_NAMES.media,
  schema: helpCenterMediaProcessPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) => `help_center.media_process:${payload.mediaId}`,
});

/**
 * M7-02: brings the install's embedding space in line with the `embedding.*`
 * settings (DOMAIN-RULES §8, ADR 0005). Every minute it compares the settings
 * with the `embedding_space` row; a new model or dimension drops the vector
 * index, resizes `knowledge_chunks.embedding`, sets `reindexing` and adds
 * {@link knowledgeReembedJob}. A settled space costs one read. A tick rather
 * than an outbox event because the settings may change in the environment as
 * well as in admin, and because the space is install-wide while every outbox
 * row belongs to a brand.
 */
export const knowledgeConfigureJob = defineJob({
  name: 'knowledge.configure',
  queue: QUEUE_NAMES.knowledge,
  schema: z.object({}),
  options: { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
  schedule: { everyMs: 60_000 },
});

/**
 * M7-02: embeds every chunk of every brand that is not yet in the target
 * model, brand by brand and batch by batch, then builds the HNSW index and
 * flips the space to `ready`. Added by {@link knowledgeConfigureJob} under the
 * fixed id {@link KNOWLEDGE_REEMBED_JOB_ID}, so it runs once at a time; a run
 * that fails leaves the space `reindexing` and the next tick resumes it from
 * the chunks still left.
 */
export const knowledgeReembedJob = defineJob({
  name: 'knowledge.reembed',
  queue: QUEUE_NAMES.knowledge,
  schema: z.object({}),
  // Removed on failure too: a failed job kept under the fixed id would make
  // every later `add` a no-op, and the tick could never resume. The failure
  // stays visible as `embedding_space.last_error`.
  options: { attempts: 1, removeOnComplete: true, removeOnFail: true },
});

export const KNOWLEDGE_REEMBED_JOB_ID = 'knowledge.reembed';

export const knowledgeSyncPayloadSchema = z.object({
  brandId: z.uuid(),
  sourceId: z.uuid(),
  /** What started it, for the first line of the sync log. */
  trigger: z.enum(['upload', 'manual', 'schedule', 'created', 'changed']),
  /** The staff member who pressed "Sync now" or saved the source. */
  actorId: z.string().max(100).optional(),
});
export type KnowledgeSyncPayload = z.infer<typeof knowledgeSyncPayloadSchema>;

/**
 * M7-03: reads one source — an uploaded file, a website crawl, Notion pages,
 * Drive folders — into documents and chunks, removes what the source no
 * longer has, and embeds the new chunks. Added by the `knowledge.sync_requested`
 * outbox handler (upload confirmed, "Sync now", source created or changed)
 * with the outbox row's id, and by the source's own job scheduler for daily
 * and weekly sources. Not one transaction: a crawl takes minutes, so each
 * document is written in a short transaction of its own, and a second run
 * that finds the source already syncing leaves it alone. Idempotent by
 * content: a document whose hash is unchanged is skipped.
 */
export const knowledgeSyncJob = defineJob({
  name: 'knowledge.sync',
  queue: QUEUE_NAMES.knowledge,
  schema: knowledgeSyncPayloadSchema,
  options: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: 1_000,
  },
});

/** The job scheduler that repeats a daily or weekly source's sync. */
export const knowledgeSyncSchedulerId = (sourceId: string): string =>
  `knowledge.sync.schedule.${sourceId}`;

export const knowledgeEmbedPayloadSchema = z.object({ brandId: z.uuid() });
export type KnowledgeEmbedPayload = z.infer<typeof knowledgeEmbedPayloadSchema>;

/**
 * M7-03: embeds every chunk of one brand that has no vector in the target
 * model yet — the chunks an article publish just wrote, most often. Added by
 * the article subscriber after it rewrites an article's chunks, with an id
 * derived from the outbox row; a second run finds nothing left to embed. A
 * failure (no embedding model, a provider down) leaves the chunks for the
 * next run or for `knowledge.reembed`; full-text retrieval finds them meanwhile.
 */
export const knowledgeEmbedJob = defineJob({
  name: 'knowledge.embed',
  queue: QUEUE_NAMES.knowledge,
  schema: knowledgeEmbedPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: 1_000,
  },
});
export const webhookDeliverPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The `webhook_deliveries` row: its frozen body, its endpoint, and its log. */
  deliveryId: z.uuid(),
});

export type WebhookDeliverPayload = z.infer<typeof webhookDeliverPayloadSchema>;

/** Attempts before a delivery is marked `failed` (M8-03). */
export const WEBHOOK_DELIVER_ATTEMPTS = 8;

/**
 * M8-03: one event to one endpoint (ARCHITECTURE §13, `webhooks` queue). The
 * delivery row is written by the `webhooks` subscriber of the domain event,
 * beside a `webhook.delivery_requested` outbox row whose handler adds this job
 * once the row has committed, as `email.send` does.
 *
 * Eight attempts, doubling from 30 seconds: the last one is 32 minutes after
 * the one before it and about an hour after the first, so a receiver that is
 * down for a deploy or a short outage still gets the event. Idempotent by
 * delivery: a delivery that already succeeded is not sent again.
 */
export const webhookDeliverJob = defineJob({
  name: 'webhook.deliver',
  queue: QUEUE_NAMES.webhooks,
  schema: webhookDeliverPayloadSchema,
  options: {
    attempts: WEBHOOK_DELIVER_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  },
  idempotencyKey: (payload) => `webhook.deliver:${payload.deliveryId}`,
});

/**
 * What a bot sends that is not an agent's reply: M6-04's welcome and language
 * confirmation, and M8-06's survey on close, the thanks after a tap and "This
 * survey has closed." for a tap that came too late.
 */
export const telegramNoticeKindSchema = z.enum([
  'welcome',
  'language_set',
  'csat_survey',
  'csat_rated',
  'csat_closed',
]);
export type TelegramNoticeKind = z.infer<typeof telegramNoticeKindSchema>;

/** M8-06: the survey a `csat_*` notice is about, and the tap it answers. */
export const telegramCsatNoticeSchema = z.object({
  surveyId: z.uuid(),
  /** The score a `csat_rated` thanks the contact for. */
  rating: z.int().min(1).max(5).optional(),
  /** The survey message whose buttons a tap's answer replaces. */
  messageId: z.string().min(1).max(32).optional(),
});
export type TelegramCsatNotice = z.infer<typeof telegramCsatNoticeSchema>;

export const telegramSendPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reply'),
    brandId: z.uuid(),
    /** The `telegram_deliveries` row: the whole job is about it, and it is the natural key. */
    deliveryId: z.uuid(),
  }),
  z.object({
    kind: z.literal('notice'),
    brandId: z.uuid(),
    /** The outbox row that asked for it, which is what a redelivery repeats. */
    sourceOutboxId: z.uuid(),
    botId: z.uuid(),
    chatId: z.string().min(1).max(32),
    notice: telegramNoticeKindSchema,
    locale: z.enum(['en', 'ar']),
    /** The button press a `language_set` or `csat_*` notice answers, so the spinner on it stops. */
    callbackQueryId: z.string().min(1).max(128).optional(),
    csat: telegramCsatNoticeSchema.optional(),
  }),
]);

export type TelegramSendPayload = z.infer<typeof telegramSendPayloadSchema>;

/** Attempts before a reply to a chat is `failed` (M6-02). */
export const TELEGRAM_SEND_JOB_ATTEMPTS = 5;

/**
 * M6-02 and M6-04's outbound Telegram (ARCHITECTURE §13, `outbound` queue): an
 * agent's reply to a chat, or the `/start` welcome and the language
 * confirmation. Asked for through the outbox — `telegram.reply` beside the
 * `telegram_deliveries` row, `telegram.notice` beside the inbound update that
 * called for it — and added by those events' handlers with the outbox row's id.
 *
 * **Idempotent** (DOMAIN-RULES §6: "Telegram send keyed by
 * `ticket_message_id`"): a reply is keyed by its delivery, which is one per
 * ticket message; a notice by the outbox row that asked for it.
 */
export const telegramSendJob = defineJob({
  name: 'telegram.send',
  queue: QUEUE_NAMES.outbound,
  schema: telegramSendPayloadSchema,
  options: {
    attempts: TELEGRAM_SEND_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  },
  idempotencyKey: (payload) =>
    payload.kind === 'reply'
      ? `telegram.send:${payload.deliveryId}`
      : `telegram.notice:${payload.sourceOutboxId}`,
});

export const telegramPollPayloadSchema = z.object({
  brandId: z.uuid(),
  botId: z.uuid(),
});

export type TelegramPollPayload = z.infer<typeof telegramPollPayloadSchema>;

/** How often a bot is polled in development. */
export const TELEGRAM_POLL_INTERVAL_MS = 3_000;

/**
 * M6-01's long polling, for development only (`TELEGRAM_POLLING=true`): one
 * `getUpdates` per bot every {@link TELEGRAM_POLL_INTERVAL_MS}, from the
 * offset on the bot's row. One BullMQ job scheduler per bot, id
 * {@link telegramPollSchedulerId}, upserted on boot and when `telegram_bot.changed`
 * says a bot came or went, as `email.poll` is for mailboxes.
 *
 * One attempt and no receipt for the reason `email.poll` has none: the next
 * tick is the retry, and every message dedupes by its own id.
 */
export const telegramPollJob = defineJob({
  name: 'telegram.poll',
  queue: QUEUE_NAMES.inbound,
  schema: telegramPollPayloadSchema,
  options: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { age: 7 * 86_400, count: 1_000 },
  },
});

/** The scheduler id of one bot's poller. */
export const telegramPollSchedulerId = (botId: string): string => `telegram.poll.${botId}`;

export const statsRollupPayloadSchema = z.object({
  brandId: z.uuid(),
  /** The hour of the tick that added it, as an ISO instant; the job id is built from it. */
  tick: z.iso.datetime(),
});
export type StatsRollupPayload = z.infer<typeof statsRollupPayloadSchema>;

/**
 * M8-04: rebuilds **one** brand's report rollups for the trailing days, and
 * backfills a brand that has none. Added hourly per active brand by
 * {@link statsRollupScheduleJob} (ARCHITECTURE §13, `maintenance` queue). No
 * receipt: a run deletes the days it covers and writes them again, so a
 * repeat leaves the same rows behind.
 */
export const statsRollupJob = defineJob({
  name: 'stats.rollup',
  queue: QUEUE_NAMES.maintenance,
  schema: statsRollupPayloadSchema,
  options: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: 1_000,
  },
});

/** The BullMQ job id of one brand's rollup for one tick. Dots, for the reason {@link retentionJobId} gives. */
export const statsRollupJobId = ({ brandId, tick }: StatsRollupPayload): string =>
  `stats.rollup.${brandId}.${Date.parse(tick)}`;

/** Seven minutes past every hour, off the top of the hour the other crons use. */
export const STATS_ROLLUP_CRON = '7 * * * *';

/** The hourly tick that fans {@link statsRollupJob} out per active brand. */
export const statsRollupScheduleJob = defineJob({
  name: 'stats.rollup.schedule',
  queue: QUEUE_NAMES.maintenance,
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnFail: 100 },
  schedule: { cron: STATS_ROLLUP_CRON },
});

export const brandPurgePayloadSchema = z.object({ brandId: z.uuid() });
export type BrandPurgePayload = z.infer<typeof brandPurgePayloadSchema>;

/**
 * M8-07: the hard purge of a brand whose 30-day grace is over (DOMAIN-RULES
 * §11) — every tenant row, the brand's object prefix and its Redis keys. Added
 * by {@link brandPurgeScheduleJob} for each brand that is due, keyed by the
 * brand, so it runs once however often the tick sees it. Every step deletes
 * "what is left", so a retry after a crash finishes the job rather than
 * repeating it.
 */
export const brandPurgeJob = defineJob({
  name: 'brand.purge',
  queue: QUEUE_NAMES.maintenance,
  schema: brandPurgePayloadSchema,
  options: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 300_000 },
    removeOnComplete: { age: 30 * 86_400, count: 1_000 },
    removeOnFail: false,
  },
});

/** One purge per brand: a brand is purged once. */
export const brandPurgeJobId = ({ brandId }: BrandPurgePayload): string => `brand.purge.${brandId}`;

/** 04:00 UTC every night, an hour after retention, so the two never compete for the disk. */
export const BRAND_PURGE_CRON = '0 4 * * *';

/** The nightly tick that adds {@link brandPurgeJob} for each brand whose grace is over. */
export const brandPurgeScheduleJob = defineJob({
  name: 'brand.purge.schedule',
  queue: QUEUE_NAMES.maintenance,
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnFail: 100 },
  schedule: { cron: BRAND_PURGE_CRON },
});

export const aiAutoReplyPayloadSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  /** The customer message to answer. A newer one makes this job stand down. */
  messageId: z.uuid(),
});
export type AiAutoReplyPayload = z.infer<typeof aiAutoReplyPayloadSchema>;

/**
 * M7-06: answers one customer message, or hands the conversation to the team
 * (DOMAIN-RULES §9). Added by the `ai` subscriber of `ticket.created` and
 * `ticket.replied` under {@link aiAutoReplyJobId}, so the two events a widget
 * start writes for one message add one job. Two attempts: a provider that
 * failed twice leaves the message to a person rather than answering late.
 * Every attempt re-reads the pause right before it sends.
 */
export const aiAutoReplyJob = defineJob({
  name: 'ai.auto_reply',
  queue: QUEUE_NAMES.ai,
  schema: aiAutoReplyPayloadSchema,
  options: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: 1_000,
  },
  idempotencyKey: ({ messageId }) => `ai.auto_reply:${messageId}`,
});

/** BullMQ refuses a custom job id with a colon. One job per customer message. */
export const aiAutoReplyJobId = (messageId: string): string => `ai.auto_reply.${messageId}`;

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
  [authEmailJob.name]: authEmailJob,
  [domainVerifyJob.name]: domainVerifyJob,
  [domainVerifyScheduleJob.name]: domainVerifyScheduleJob,
  [helpCenterPublishDueJob.name]: helpCenterPublishDueJob,
  [helpCenterPublishDueSweepJob.name]: helpCenterPublishDueSweepJob,
  [helpCenterMediaProcessJob.name]: helpCenterMediaProcessJob,
  [helpCenterSearchReindexJob.name]: helpCenterSearchReindexJob,
  [helpCenterSearchReindexSweepJob.name]: helpCenterSearchReindexSweepJob,
  [knowledgeConfigureJob.name]: knowledgeConfigureJob,
  [knowledgeReembedJob.name]: knowledgeReembedJob,
  [webhookDeliverJob.name]: webhookDeliverJob,
  [telegramSendJob.name]: telegramSendJob,
  [telegramPollJob.name]: telegramPollJob,
  [statsRollupJob.name]: statsRollupJob,
  [statsRollupScheduleJob.name]: statsRollupScheduleJob,
  [brandPurgeJob.name]: brandPurgeJob,
  [brandPurgeScheduleJob.name]: brandPurgeScheduleJob,
  [aiAutoReplyJob.name]: aiAutoReplyJob,
} as const);

export type JobName = keyof typeof JOB_DEFINITIONS;
