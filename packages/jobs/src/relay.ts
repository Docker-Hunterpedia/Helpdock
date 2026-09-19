import {
  brands,
  type Db,
  type DbTransaction,
  isUuid,
  outbox,
  type TenantContext,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { type ConnectionOptions, type JobsOptions, Queue } from 'bullmq';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  OUTBOX_RELAY_INTERVAL_MS,
  outboxEventJob,
  outboxRelayJob,
  parseJobPayload,
} from './jobs.js';
import { type JobLogger, silentLogger } from './logger.js';
import { QUEUE_NAMES } from './queues.js';
import { type RelayStatusStore, writeRelayStatus } from './relay-status.js';
import { createWaiter } from './waiter.js';

/**
 * The relay of DOMAIN-RULES §6. It is the only thing that turns a committed
 * `outbox` row into a BullMQ job, and it does so with `jobId = outbox.id` inside
 * the transaction that stamps `published_at`.
 *
 * That ordering is deliberate. A crash after the `add` and before the commit
 * leaves the row unpublished, so the next cycle adds the same job id again and
 * BullMQ ignores it; a crash before the `add` leaves the row unpublished and the
 * next cycle publishes it. Neither order can lose a job, and the only cost is
 * that a job may be added twice — which is why every consumer is idempotent.
 */

/** The channel the `outbox_notify_relay` trigger signals on after each insert. */
export const OUTBOX_NOTIFY_CHANNEL = 'outbox';

/** Rows one brand publishes per cycle. A full batch makes the relay cycle again at once. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * Brands whose pending work is discovered in one query. The discovery read is
 * the only place the relay holds more than one brand in its tenant context, and
 * the batch bounds how much of the install one statement can see.
 */
const BRAND_DISCOVERY_BATCH = 50;

/** First key of the per-brand advisory lock; ASCII "HD". Keeps our locks out of anyone else's space. */
export const OUTBOX_RELAY_LOCK_NAMESPACE = 0x4844;

/** How many hex digits of a brand uuid fit in the int4 the lock takes. */
const LOCK_KEY_HEX_DIGITS = 8;

/**
 * The second key of the advisory lock, derived from the brand id. Postgres takes
 * two `int4`s, and a uuid does not fit, so the first 32 bits stand in. Two brands
 * that collide only serialise with each other; each still publishes rows its own
 * transaction can see, so a collision costs throughput and never correctness.
 */
export const advisoryLockKey = (brandId: string): number => {
  if (!isUuid(brandId)) {
    throw new TypeError('advisoryLockKey expects a UUID brand id');
  }
  // `| 0` reinterprets the 32 bits as the signed int4 Postgres expects.
  return Number.parseInt(brandId.slice(0, LOCK_KEY_HEX_DIGITS), 16) | 0;
};

/** Splits a list into consecutive runs of at most `size`. */
export const chunk = <T>(values: readonly T[], size: number): readonly (readonly T[])[] => {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('chunk expects a positive integer size');
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

/**
 * What the relay needs from BullMQ. Narrowing it to `add` is what lets a test
 * fail between the add and the commit without a seam in production code.
 */
export interface JobQueue {
  add(name: string, data: unknown, options: JobsOptions): Promise<unknown>;
}

/**
 * The relay's discovery context. It is a system path that deliberately holds
 * several brands at once (DOMAIN-RULES §1.2 otherwise reserves that to install
 * admin), and it is narrow on purpose: the statement reads `brand_id` from
 * `outbox` and nothing else, no payload and no other table. Publishing then runs
 * one brand at a time under {@link withSystem}, which is the context
 * DOMAIN-RULES §1.4 gives a worker.
 */
const discoveryContext = (brandIds: readonly string[]): TenantContext => ({
  brandIds,
  departmentIds: 'all',
  principalType: 'system',
  principalId: outboxRelayJob.name,
});

/**
 * Every brand the relay may publish for. `brands` is a global table
 * (DOMAIN-RULES §1.3), so this read needs no tenant context — which is what
 * breaks the circle: a tenant context cannot be built without knowing the
 * brands, and the brands cannot be read from a tenant table without one.
 *
 * Suspended and soft-deleted brands are included. An outbox row exists because a
 * transaction committed it, and dropping committed work because the brand's
 * status changed afterwards would silently lose a side effect; whether the
 * effect should still happen is the consumer's decision.
 */
export const listRelayBrandIds = async (db: Db): Promise<readonly string[]> => {
  const rows = await db.select({ id: brands.id }).from(brands).orderBy(asc(brands.id));
  return rows.map((row) => row.id);
};

/** A brand with work waiting, and how much of it. */
export interface UnpublishedBrand {
  readonly brandId: string;
  readonly rows: number;
}

/**
 * The subset of `brandIds` that has unpublished rows, with a count each, read in
 * batches.
 *
 * The count comes from the same grouped statement that finds the brands, so
 * knowing the size of the backlog costs nothing on top of knowing that there is
 * one. It is what the relay reports for `outbox_unpublished_rows` (ARCHITECTURE
 * §14) and what the admin System page shows beside the worker.
 */
export const findUnpublishedRowCounts = async (
  db: Db,
  brandIds: readonly string[],
): Promise<readonly UnpublishedBrand[]> => {
  const pending: UnpublishedBrand[] = [];

  for (const batch of chunk(brandIds, BRAND_DISCOVERY_BATCH)) {
    const rows = await withTenant(db, discoveryContext(batch), (tx) =>
      tx
        .select({ brandId: outbox.brandId, rows: count() })
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .groupBy(outbox.brandId),
    );
    pending.push(...rows.map((row) => ({ brandId: row.brandId, rows: row.rows })));
  }

  return pending;
};

const tryLockBrand = async (tx: DbTransaction, brandId: string): Promise<boolean> => {
  const rows = await tx.execute<{ locked: boolean }>(
    // Both arguments are cast: `pg_try_advisory_xact_lock` is overloaded on
    // `(bigint)` and `(int, int)`, and untyped parameters make the call ambiguous.
    sql`SELECT pg_try_advisory_xact_lock(${OUTBOX_RELAY_LOCK_NAMESPACE}::int, ${advisoryLockKey(brandId)}::int) AS locked`,
  );
  return [...rows][0]?.locked === true;
};

export interface PublishBrandOptions {
  readonly db: Db;
  readonly queue: JobQueue;
  readonly brandId: string;
  readonly batchSize?: number | undefined;
  readonly log?: JobLogger | undefined;
}

export interface PublishBrandResult {
  readonly published: number;
  /** True when another replica held the brand's advisory lock and this one stood down. */
  readonly skipped: boolean;
}

/** One unpublished row, as the relay reads it. */
interface UnpublishedRow {
  readonly id: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Adds one job per row, with `jobId = outbox.id`. Every payload is validated on
 * the way out: a row that cannot become a valid job stops the batch, and the
 * caller's transaction rolls back, rather than putting a job in Redis that no
 * consumer can parse.
 */
const addEventJobs = async (
  queue: JobQueue,
  brandId: string,
  rows: readonly UnpublishedRow[],
): Promise<void> => {
  for (const row of rows) {
    const payload = parseJobPayload(outboxEventJob, {
      outboxId: row.id,
      brandId,
      event: row.event,
      payload: row.payload,
    });
    await queue.add(outboxEventJob.name, payload, { ...outboxEventJob.options, jobId: row.id });
  }
};

/**
 * Publishes one brand's backlog, up to `batchSize` rows, inside a single
 * transaction that holds the brand's advisory lock for its duration. Two
 * replicas therefore never publish the same brand at the same time, and the lock
 * is released by the commit or the rollback rather than by any code path.
 */
export const publishBrand = ({
  db,
  queue,
  brandId,
  batchSize = DEFAULT_BATCH_SIZE,
  log = silentLogger,
}: PublishBrandOptions): Promise<PublishBrandResult> =>
  withSystem(db, brandId, async (tx) => {
    if (!(await tryLockBrand(tx, brandId))) {
      return { published: 0, skipped: true };
    }

    const rows = await tx
      .select({ id: outbox.id, event: outbox.event, payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.brandId, brandId), isNull(outbox.publishedAt)))
      .orderBy(asc(outbox.id))
      .limit(batchSize);

    if (rows.length === 0) {
      return { published: 0, skipped: false };
    }

    await addEventJobs(queue, brandId, rows);

    await tx
      .update(outbox)
      .set({ publishedAt: new Date() })
      .where(
        inArray(
          outbox.id,
          rows.map((row) => row.id),
        ),
      );

    log.info({ brandId, published: rows.length }, 'outbox relay published rows');
    return { published: rows.length, skipped: false };
  });

export interface RelayCycleOptions {
  readonly db: Db;
  readonly queue: JobQueue;
  readonly batchSize?: number | undefined;
  readonly log?: JobLogger | undefined;
  /** Brands this relay owns. Defaults to every brand; tests and shards narrow it. */
  readonly brandIds?: readonly string[] | undefined;
}

export interface RelayCycleResult {
  readonly published: number;
  /** Unpublished rows across every brand this relay owns, as the cycle started. */
  readonly pending: number;
  /** Brands that had unpublished rows when the cycle started. */
  readonly brands: number;
  /** Brands another replica was already publishing. */
  readonly skipped: number;
  /** Brands whose batch threw. Their rows stay unpublished and are retried next cycle. */
  readonly failed: number;
  /** A brand filled its batch, so there is certainly more to do. */
  readonly hasMore: boolean;
}

/** One pass: find the brands with work, then publish each one's batch. */
export const runRelayCycle = async ({
  db,
  queue,
  batchSize = DEFAULT_BATCH_SIZE,
  log = silentLogger,
  brandIds,
}: RelayCycleOptions): Promise<RelayCycleResult> => {
  const candidates = brandIds ?? (await listRelayBrandIds(db));
  if (candidates.length === 0) {
    return { published: 0, pending: 0, brands: 0, skipped: 0, failed: 0, hasMore: false };
  }

  const waiting = await findUnpublishedRowCounts(db, candidates);
  const pending = waiting.reduce((total, brand) => total + brand.rows, 0);

  let published = 0;
  let skipped = 0;
  let failed = 0;
  let hasMore = false;

  for (const { brandId } of waiting) {
    try {
      const result = await publishBrand({ db, queue, brandId, batchSize, log });
      published += result.published;
      skipped += result.skipped ? 1 : 0;
      hasMore ||= result.published === batchSize;
    } catch (error) {
      // One brand's failure — an unparseable row, a lock timeout — must not stop
      // the others, or one tenant's bad data would hold up the whole install.
      // The transaction rolled back, so the next cycle publishes these rows again.
      failed += 1;
      log.error({ brandId, err: error }, 'outbox relay could not publish a brand');
    }
  }

  return { published, pending, brands: waiting.length, skipped, failed, hasMore };
};

export interface StartOutboxRelayOptions {
  readonly db: Db;
  /** Connection the relay's `outbox` queue uses. Share the worker's ioredis instance. */
  readonly redis: ConnectionOptions;
  readonly log?: JobLogger | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly batchSize?: number | undefined;
  /**
   * `DATABASE_URL`. The relay opens one connection of its own for
   * `LISTEN outbox`, because a pooled connection cannot hold a subscription.
   * Without it the relay still works, one poll interval slower.
   */
  readonly listenUrl?: string | undefined;
  /** Brands this relay owns. Defaults to every brand. */
  readonly brandIds?: readonly string[] | undefined;
  /**
   * Where each cycle is reported, for `/metrics` and the admin System page
   * (ARCHITECTURE §14). Pass the same connection given as `redis`; BullMQ owns
   * its own client and does not lend it out. Without it the relay runs exactly
   * as before and the System page says the worker has not reported.
   */
  readonly status?: RelayStatusStore | undefined;
}

export interface OutboxRelay {
  /**
   * Stops the loop, drops the subscription and closes the queue. Idempotent, so
   * a shutdown handler that runs on both SIGTERM and SIGINT is safe.
   */
  stop(): Promise<void>;
}

/**
 * Starts the relay loop. It runs a cycle, then waits for either a `LISTEN outbox`
 * notification or `pollIntervalMs`, whichever comes first. The notification is
 * latency; the poll is the guarantee, so losing the subscription degrades the
 * relay rather than stopping it.
 */
export const startOutboxRelay = ({
  db,
  redis,
  log = silentLogger,
  pollIntervalMs = OUTBOX_RELAY_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  listenUrl,
  brandIds,
  status,
}: StartOutboxRelayOptions): OutboxRelay => {
  const queue = new Queue(QUEUE_NAMES.outbox, { connection: redis });
  const waiter = createWaiter();

  let stopped = false;
  let notifyClient: ReturnType<typeof postgres> | undefined;
  let unlisten: (() => Promise<void>) | undefined;

  const subscribe = async (): Promise<void> => {
    if (listenUrl === undefined) {
      return;
    }

    const client = postgres(listenUrl, { max: 1, onnotice: () => {} });
    notifyClient = client;
    const subscription = await client.listen(OUTBOX_NOTIFY_CHANNEL, () => waiter.notify());
    unlisten = () => subscription.unlisten();
  };

  /**
   * Publishing the heartbeat must never be able to stop the relay: a Redis that
   * refuses the write is a blind operator, and a relay that stopped over it
   * would be a lost side effect.
   */
  const report = async (result: RelayCycleResult, durationMs: number): Promise<void> => {
    if (status === undefined) {
      return;
    }

    try {
      await writeRelayStatus(status, {
        at: new Date().toISOString(),
        durationMs,
        pending: result.pending,
        published: result.published,
        brands: result.brands,
        skipped: result.skipped,
        failed: result.failed,
      });
    } catch (error) {
      log.warn({ err: error }, 'outbox relay could not publish its cycle status');
    }
  };

  const run = async (): Promise<void> => {
    try {
      await subscribe();
    } catch (error) {
      // Degrading to the poll is the documented fallback: the subscription is
      // latency, the poll is the guarantee.
      log.error(
        { err: error },
        'outbox relay could not subscribe to LISTEN outbox; falling back to polling',
      );
    }

    while (!stopped) {
      try {
        const startedAt = Date.now();
        const result = await runRelayCycle({ db, queue, batchSize, log, brandIds });
        await report(result, Date.now() - startedAt);
        if (result.hasMore) {
          continue;
        }
      } catch (error) {
        // Discovery itself failed — the database or Redis is unreachable. The
        // relay has to outlive that, because nothing else republishes the
        // backlog; the next cycle reads the same rows.
        log.error({ err: error }, 'outbox relay cycle failed');
      }

      await waiter.wait(pollIntervalMs);
    }
  };

  const finished = run();
  let shutdown: Promise<void> | undefined;

  const shutDown = async (): Promise<void> => {
    stopped = true;
    waiter.notify();
    await finished;
    await unlisten?.();
    await notifyClient?.end();
    await queue.close();
  };

  return {
    stop: () => {
      shutdown ??= shutDown();
      return shutdown;
    },
  };
};
