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
  /** Their names, newest first, read at boot for the same reason; null where the count is. */
  migrations: z.array(z.string().min(1)).nullable(),
  /**
   * The whole database on disk (`pg_database_size`), or null when the server
   * did not answer. Install-wide: a brand's share is spread over every table
   * and index, and measuring it would mean reading every row.
   */
  sizeBytes: z.number().nonnegative().nullable(),
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
 * A channel's connection health, for every brand: its mailboxes (M2) and
 * Telegram bots (M6), read by `apps/api/src/channels/channel-status.ts`.
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

/** One brand's share of the bucket: everything under `brands/<id>/`. */
export const brandStorageSchema = z.object({
  brandId: z.uuid(),
  name: z.string(),
  usedBytes: z.number().nonnegative(),
  objects: z.int().nonnegative(),
  measuredAt: z.iso.datetime(),
});
export type BrandStorage = z.infer<typeof brandStorageSchema>;

/**
 * Attachment and article image storage (M8-05). Measuring is listing the
 * bucket, so the worker's hourly `stats.rollup` does it per brand at most
 * every six hours and the page reads the last readings. Until the first one
 * there is nothing to report, and the answer is `configured: false` rather
 * than a zero that looks like an empty bucket.
 */
export const systemStorageSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    usedBytes: z.number().nonnegative(),
    /** The soft limit an operator set, or `null` when there is none. */
    softLimitBytes: z.number().positive().nullable(),
    /** Per brand, largest first. */
    brands: z.array(brandStorageSchema).optional(),
  }),
]);
export type SystemStorage = z.infer<typeof systemStorageSchema>;

/** One brand's LLM spend in the current month, against its own monthly budget. */
export const brandAiSpendSchema = z.object({
  brandId: z.uuid(),
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Null when the brand has no monthly limit. */
  budgetUsd: z.number().positive().nullable(),
});
export type BrandAiSpend = z.infer<typeof brandAiSpendSchema>;

/**
 * LLM spend for the current budget window, install-wide and per brand, from
 * `ai_calls` through `AiUsageSource` (M7).
 */
export const systemAiSpendSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    tokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    budgetUsd: z.number().positive().nullable(),
    /** DESIGN and ARCHITECTURE §10: a soft alert at 80 % of the budget. */
    alertAtPercent: z.number().min(0).max(100).nullable(),
    /** Every brand not yet purged, largest spend first. */
    brands: z.array(brandAiSpendSchema),
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

/**
 * The product metrics of DOMAIN-RULES §15 that the install can measure about
 * itself (M8-07). Agent efficiency and handoff quality are measured by people
 * in the M9 usability pass, not here.
 */
export const productMetricsSchema = z.object({
  observedAt: z.iso.datetime(),
  activation: z.object({
    /** When the first brand was created: the end of the first-run wizard. */
    wizardCompletedAt: z.iso.datetime().nullable(),
    /** The first ticket from any channel but a manual one, in any brand. */
    firstChannelTicketAt: z.iso.datetime().nullable(),
    /** Whether that ticket came within 7 days of the wizard. */
    activated: z.boolean(),
  }),
  /** The window the per-brand rates are over, in days, ending today. */
  windowDays: z.int().positive(),
  brands: z.array(
    z.object({
      brandId: z.uuid(),
      name: z.string(),
      selfService: z.object({
        articleViews: z.int().nonnegative(),
        /** Views a ticket could be traced to: those made in the widget. */
        widgetViews: z.int().nonnegative(),
        followedByTicket: z.int().nonnegative(),
        /** Widget views not followed by a ticket within an hour, over widget views. */
        rate: z.number().min(0).max(1).nullable(),
      }),
      /** Null until the AI subsystem records auto-replies (M7). */
      aiDeflectionRate: z.number().min(0).max(1).nullable(),
    }),
  ),
});
export type ProductMetrics = z.infer<typeof productMetricsSchema>;

/**
 * The one-time address that opens Bull Board in a new tab (M8-05, ADR 0017).
 * Spent on first use and good for a minute.
 */
export const queueBoardPassSchema = z.object({ url: z.string().startsWith('/') });
export type QueueBoardPass = z.infer<typeof queueBoardPassSchema>;
