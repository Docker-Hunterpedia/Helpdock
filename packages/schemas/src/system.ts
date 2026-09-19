import { z } from 'zod';
import { readinessCheckSchema } from './health.js';

/**
 * What the admin System page shows (REQUIREMENTS §4.10, ARCHITECTURE §14):
 * version and git sha, migrations, queue health, channel status, storage usage,
 * LLM spend, health checks and the audit log.
 *
 * It is one install-scope read, because the page is one screen and an operator
 * looking at it wants a consistent picture rather than eight requests that
 * disagree with each other. Nothing here is per-brand.
 *
 * Two rules the shapes encode:
 *
 * - **A subsystem that is not configured says so.** `{ configured: false }` is a
 *   distinct state from "configured and empty", and the page prints "Not
 *   configured" rather than a zero that reads like a measurement.
 * - **Nothing carries a secret or a URL.** The Redis and Postgres facts are
 *   versions and counters; a connection string, a host or a credential would
 *   turn a status page into a disclosure.
 */

/** How a card reads: a hue and a shape, never a hue alone (DESIGN §10). */
export const componentStatusSchema = z.enum(['ok', 'warning', 'error']);
export type ComponentStatus = z.infer<typeof componentStatusSchema>;

export const systemBuildSchema = z.object({
  /** `version` from the api's `package.json`. */
  version: z.string().min(1),
  /**
   * The commit the image was built from, short form. `unknown` in a development
   * tree, where no build argument was baked in.
   */
  gitSha: z.string().min(1),
  nodeVersion: z.string().min(1),
  /** This replica's uptime. A restart shows up here before it shows up anywhere else. */
  uptimeSeconds: z.number().nonnegative(),
});
export type SystemBuild = z.infer<typeof systemBuildSchema>;

/** A readiness probe with the time it took, which is the half `/ready` leaves out. */
export const systemCheckSchema = readinessCheckSchema.extend({
  latencyMs: z.number().nonnegative(),
});
export type SystemCheck = z.infer<typeof systemCheckSchema>;

export const systemDatabaseSchema = z.object({
  status: componentStatusSchema,
  /** `17.6`. The server version, not the driver's. */
  version: z.string().nullable(),
  /**
   * How far the schema has been brought, counted by the owner connection when
   * this replica migrated at boot. `null` when this process did not migrate and
   * so cannot know: the migration log is in the `drizzle` schema, which the
   * runtime role is deliberately not granted (DOMAIN-RULES §1.5).
   */
  migrationsApplied: z.number().int().nonnegative().nullable(),
  /** Read once at boot from `assertRuntimeRoleIsSafe` (DOMAIN-RULES §1.5). */
  runtimeRole: z.object({
    name: z.string().min(1),
    superuser: z.boolean(),
    bypassRls: z.boolean(),
    ownedTables: z.number().int().nonnegative(),
  }),
  latencyMs: z.number().nonnegative(),
});
export type SystemDatabase = z.infer<typeof systemDatabaseSchema>;

export const systemRedisSchema = z.object({
  status: componentStatusSchema,
  version: z.string().nullable(),
  /**
   * Redis is rewriting its append-only file. Not a failure, but it costs
   * latency, so the page shows the connection as degraded while it runs.
   */
  aofRewriteInProgress: z.boolean(),
  latencyMs: z.number().nonnegative(),
});
export type SystemRedis = z.infer<typeof systemRedisSchema>;

/** One queue's depth, as BullMQ counts it (ARCHITECTURE §13). */
export const queueCountsSchema = z.object({
  name: z.string().min(1),
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  /** Age of the oldest waiting job, or `null` when nothing is waiting. */
  oldestWaitingSeconds: z.number().nonnegative().nullable(),
});
export type QueueCounts = z.infer<typeof queueCountsSchema>;

export const systemQueuesSchema = z.object({
  queues: z.array(queueCountsSchema),
  /** Every queue there is, so the page can say "showing 5 of 11". */
  total: z.number().int().nonnegative(),
  /** Jobs in the failed set across every queue: the dead-letter count. */
  deadLettered: z.number().int().nonnegative(),
});
export type SystemQueues = z.infer<typeof systemQueuesSchema>;

/**
 * The outbox relay's last reported cycle (DOMAIN-RULES §6). `reporting: false`
 * means no relay has written its heartbeat — either no worker is running, or it
 * has not finished a cycle yet.
 */
export const systemRelaySchema = z.discriminatedUnion('reporting', [
  z.object({ reporting: z.literal(false) }),
  z.object({
    reporting: z.literal(true),
    at: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    /** Unpublished rows across every brand, as the relay last counted them. */
    pending: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
]);
export type SystemRelay = z.infer<typeof systemRelaySchema>;

/**
 * A channel's connection health. The list is empty in M0; M2 (email) and M6
 * (Telegram) fill it from `channels.status` and the adapter's `health()`
 * (ARCHITECTURE §8).
 */
export const channelStatusSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  kind: z.enum(['email', 'telegram', 'widget', 'form', 'api']),
  status: componentStatusSchema,
  /** One short line, already resolved to a catalog key by the page. Never a credential. */
  detail: z.string(),
  checkedAt: z.iso.datetime(),
});
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

/**
 * Attachment storage. S3 is configured in `.env` but nothing measures the
 * bucket until the media pipeline lands with M1, so M0 always reports
 * `configured: false` rather than a zero that looks like an empty bucket.
 */
export const systemStorageSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    usedBytes: z.number().nonnegative(),
    /** The soft limit an operator set, or `null` when there is none. */
    softLimitBytes: z.number().positive().nullable(),
  }),
]);
export type SystemStorage = z.infer<typeof systemStorageSchema>;

/** LLM spend for the current budget window. Filled in by M7. */
export const systemAiSpendSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    tokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    budgetUsd: z.number().positive().nullable(),
    /** DESIGN and ARCHITECTURE §10: a soft alert at 80 % of the budget. */
    alertAtPercent: z.number().min(0).max(100).nullable(),
  }),
]);
export type SystemAiSpend = z.infer<typeof systemAiSpendSchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  actorType: z.enum(['staff', 'visitor', 'apikey', 'system']),
  actorId: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const systemStatusSchema = z.object({
  /** When this snapshot was taken, so a stale tab can say so. */
  observedAt: z.iso.datetime(),
  build: systemBuildSchema,
  /** How many api replicas this install is configured for, when it can be known. */
  api: z.object({
    status: componentStatusSchema,
    checks: z.array(systemCheckSchema),
  }),
  database: systemDatabaseSchema,
  redis: systemRedisSchema,
  relay: systemRelaySchema,
  queues: systemQueuesSchema,
  channels: z.array(channelStatusSchema),
  storage: systemStorageSchema,
  aiSpend: systemAiSpendSchema,
  /** The most recent install-scope audit rows, newest first. */
  audit: z.array(auditEntrySchema),
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;

/** `?page=` and `?pageSize=` for the full queue list. */
export const systemQueuesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
});
export type SystemQueuesQuery = z.infer<typeof systemQueuesQuerySchema>;

export const systemQueuePageSchema = systemQueuesSchema.extend({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type SystemQueuePage = z.infer<typeof systemQueuePageSchema>;
