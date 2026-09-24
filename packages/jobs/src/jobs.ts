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
 * M0 defines three: the relay itself, the fan-out job it publishes, and the
 * nightly retention job of DOMAIN-RULES §11. Later milestones add the rest of
 * ARCHITECTURE §13 beside them.
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
  olderThanDays: z.int().min(1).max(3_650).default(RETENTION_DAYS),
});

export type MaintenanceRetentionPayload = z.infer<typeof maintenanceRetentionPayloadSchema>;

/**
 * Nightly retention for one brand (DOMAIN-RULES §11). M0-14 defines the job and
 * ships the purges it will call ({@link ../retention.js}); the fan-out that
 * enqueues one job per brand, and the audit-log counts, belong to the retention
 * deliverable in M9.
 */
export const maintenanceRetentionJob = defineJob({
  name: 'maintenance.retention',
  queue: QUEUE_NAMES.maintenance,
  schema: maintenanceRetentionPayloadSchema,
  options: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnFail: false },
  schedule: { cron: '0 3 * * *' },
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

/** Every job defined so far, by name. Bull Board and the metrics reader iterate it. */
export const JOB_DEFINITIONS = Object.freeze({
  [outboxRelayJob.name]: outboxRelayJob,
  [outboxEventJob.name]: outboxEventJob,
  [maintenanceRetentionJob.name]: maintenanceRetentionJob,
  [mediaProcessJob.name]: mediaProcessJob,
  [assignmentOfflineUnassignJob.name]: assignmentOfflineUnassignJob,
} as const);

export type JobName = keyof typeof JOB_DEFINITIONS;
