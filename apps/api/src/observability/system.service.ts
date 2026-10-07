import { auditLog, brands, type Db } from '@helpdock/db';
import { readRelayStatus } from '@helpdock/jobs';
import type {
  AuditEntry,
  ChannelStatus,
  ProductMetrics,
  SystemQueuePage,
  SystemQueuesQuery,
  SystemStatus,
} from '@helpdock/schemas';
import { Inject, Injectable } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getTx } from '../context/request-context.js';
import { AI_USAGE_SOURCE, type AiUsageSource } from '../reports/ai-usage.js';
import { ReadinessService } from '../runtime/readiness.service.js';
import { DB, REDIS } from '../runtime/tokens.js';
import type { BootFacts } from './boot-facts.js';
import { buildInfo } from './build-info.js';
import { ProductMetricsService } from './product-metrics.js';
import type { QueueRegistry } from './queues.js';
import type { StorageUsageStore } from './storage-usage.js';
import { readPostgresFacts, readRedisFacts } from './system-facts.js';
import {
  checkNamed,
  checksStatus,
  dependencyStatus,
  queuePageView,
  queuesView,
  relayView,
  storageView,
} from './system-view.js';
import { BOOT_FACTS, CHANNEL_STATUS, QUEUE_REGISTRY, STORAGE_USAGE } from './tokens.js';

/** Every brand's mailboxes and bots with their health (`channels/channel-status.ts`). */
export type ChannelStatusReader = () => Promise<readonly ChannelStatus[]>;

/**
 * Everything the System page shows, in one read (REQUIREMENTS §4.10).
 *
 * Two things are worth saying about where the numbers come from.
 *
 * **The outbox backlog is reported, not queried.** The relay writes it to Redis
 * after every cycle (`@helpdock/jobs`, `relay-status.ts`). An install-scope
 * request holds only the install sentinel in `app.brand_ids`, so it cannot see
 * another brand's `outbox` rows at all — and widening the transaction to count
 * them would be exactly the kind of quiet cross-tenant read DOMAIN-RULES §1.3
 * exists to prevent. The relay already has the system context it needs, so it
 * says what it saw and this route repeats it.
 *
 * **Subsystems that have nothing to report say so.** Storage before its first
 * measurement, and AI spend until M7 records calls, answer
 * `{ configured: false }` rather than zeroes, because a zero on a status page
 * is a measurement and this would be a guess.
 *
 * **Storage is read from the readings the worker keeps in Redis** (M8-05,
 * `storage-usage.ts`): measuring the bucket is not something a page load
 * should wait on.
 */

/** The queues the summary card lists before "All queues" (DESIGN artboard `Admin/System`). */
const SUMMARY_QUEUE_LIMIT = 5;

/** Audit rows the page shows. It is a glance at activity, not the audit view. */
const AUDIT_PREVIEW_LIMIT = 10;

@Injectable()
export class SystemService {
  readonly #db: Db;
  readonly #redis: Redis;
  readonly #readiness: ReadinessService;
  readonly #queues: QueueRegistry;
  readonly #boot: BootFacts;
  readonly #channels: ChannelStatusReader;
  readonly #storage: StorageUsageStore;
  readonly #ai: AiUsageSource;

  constructor(
    @Inject(DB) db: Db,
    @Inject(REDIS) redis: Redis,
    @Inject(ReadinessService) readiness: ReadinessService,
    @Inject(QUEUE_REGISTRY) queues: QueueRegistry,
    @Inject(BOOT_FACTS) boot: BootFacts,
    @Inject(CHANNEL_STATUS) channels: ChannelStatusReader,
    @Inject(STORAGE_USAGE) storage: StorageUsageStore,
    @Inject(AI_USAGE_SOURCE) ai: AiUsageSource,
  ) {
    this.#db = db;
    this.#redis = redis;
    this.#readiness = readiness;
    this.#queues = queues;
    this.#boot = boot;
    this.#channels = channels;
    this.#storage = storage;
    this.#ai = ai;
  }

  async status(): Promise<SystemStatus> {
    // The audit rows come first and on their own: they are the one tenant read
    // here, and they run inside the request's transaction, where the install
    // scope decides what they can see.
    const audit = await this.#auditPreview();

    const now = new Date();
    const [checks, postgres, redis, relayStatus, queueCounts, channels, storage, aiSpend] =
      await Promise.all([
        this.#readiness.detail(),
        readPostgresFacts(this.#db),
        readRedisFacts(this.#redis),
        readRelayStatus(this.#redis).catch(() => null),
        this.#queues.counts().catch(() => []),
        this.#channels().catch(() => []),
        this.#storageReading(),
        this.#ai.installSpend(this.#db).catch(() => ({ configured: false as const })),
      ]);

    const databaseCheck = checkNamed(checks, 'database');

    return {
      observedAt: now.toISOString(),
      build: buildInfo(),
      api: { status: checksStatus(checks), checks: [...checks] },
      database: {
        status: dependencyStatus({
          reachable: databaseCheck?.status === 'up',
          latencyMs: databaseCheck?.latencyMs ?? 0,
        }),
        version: postgres.version,
        migrationsApplied: this.#boot.migrationsApplied,
        migrations: this.#boot.migrations === null ? null : [...this.#boot.migrations],
        sizeBytes: postgres.sizeBytes,
        runtimeRole: {
          name: this.#boot.runtimeRole.roleName,
          superuser: this.#boot.runtimeRole.superuser,
          bypassRls: this.#boot.runtimeRole.bypassRls,
          ownedTables: this.#boot.runtimeRole.ownedTables,
        },
        latencyMs: databaseCheck?.latencyMs ?? 0,
      },
      redis: {
        status: dependencyStatus({
          reachable: redis.reachable,
          latencyMs: redis.latencyMs,
          degraded: redis.aofRewriteInProgress,
        }),
        version: redis.version,
        aofRewriteInProgress: redis.aofRewriteInProgress,
        latencyMs: redis.latencyMs,
      },
      relay: relayView(relayStatus),
      queues: queuesView(queueCounts, SUMMARY_QUEUE_LIMIT),
      // M2's mailboxes and M6's bots, each with the health its own list shows.
      channels: [...channels],
      storage,
      aiSpend,
      audit: [...audit],
    };
  }

  /** DOMAIN-RULES §15's product metrics (M8-07); see `product-metrics.ts`. */
  async productMetrics(): Promise<ProductMetrics> {
    return new ProductMetricsService(this.#db, this.#ai).read();
  }

  /** Fail-soft like the rest: a Redis blip shows "not measured", not a 500. */
  async #storageReading(): Promise<SystemStatus['storage']> {
    try {
      const readings = await this.#storage.all();
      const names = await this.#db.select({ id: brands.id, name: brands.name }).from(brands);
      return storageView(readings, new Map(names.map((brand) => [brand.id, brand.name])));
    } catch {
      return { configured: false };
    }
  }

  /**
   * The same fail-soft policy as {@link status}: a Redis blip should leave the
   * queue table empty, not turn the page into a 500.
   */
  async queuePage(query: SystemQueuesQuery): Promise<SystemQueuePage> {
    const counts = await this.#queues.counts().catch(() => []);

    return queuePageView(counts, query);
  }

  /**
   * The newest install-scope audit rows. The transaction this runs in holds the
   * install sentinel, so these are install-wide entries — a brand's own rows are
   * not reachable from here and are not meant to be.
   */
  async #auditPreview(): Promise<readonly AuditEntry[]> {
    const rows = await getTx()
      .select({
        id: auditLog.id,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(AUDIT_PREVIEW_LIMIT);

    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }
}
