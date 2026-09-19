import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_ROLE_NAME,
  brands,
  createDb,
  type Db,
  type DbHandle,
  outbox,
  runMigrations,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { enqueueOutbox } from './outbox.js';
import { QUEUE_NAMES } from './queues.js';
import { createQueueConnection } from './redis.js';
import {
  advisoryLockKey,
  findUnpublishedRowCounts,
  type JobQueue,
  listRelayBrandIds,
  OUTBOX_RELAY_LOCK_NAMESPACE,
  publishBrand,
  runRelayCycle,
  startOutboxRelay,
} from './relay.js';
import { readRelayStatus } from './relay-status.js';

/**
 * The relay guarantees of DOMAIN-RULES §6, against a real Postgres and a real
 * Redis: a rolled-back transaction enqueues nothing, a committed one enqueues
 * exactly once, a crash between the `add` and the commit costs nothing, two
 * replicas do not double-publish, and no relay reaches another brand's rows.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the outbox relay tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const brandA = uuidv7();
const brandB = uuidv7();

const settingsChanged = (brandId: string) => ({
  brandId,
  event: 'settings.changed',
  payload: { key: 'smtp.host' },
});

describe.skipIf(!hasDocker)('the outbox relay', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let handle: DbHandle;
  let db: Db;
  let queue: Queue;
  let appUrl: string;

  const write = (brandId: string): Promise<string> =>
    withSystem(db, brandId, (tx) => enqueueOutbox(tx, settingsChanged(brandId)));

  const unpublishedIds = (brandId: string): Promise<string[]> =>
    withSystem(db, brandId, async (tx) => {
      const rows = await tx
        .select({ id: outbox.id })
        .from(outbox)
        .where(and(eq(outbox.brandId, brandId), isNull(outbox.publishedAt)));
      return rows.map((row) => row.id);
    });

  const waitingJobIds = async (): Promise<string[]> => {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    return jobs.flatMap((job) => (job.id === undefined ? [] : [job.id]));
  };

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });

    appUrl = `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`;
    handle = createDb({ url: appUrl });
    db = handle.db;

    await db.insert(brands).values([
      { id: brandA, name: 'Acme', prefix: 'ACME' },
      { id: brandB, name: 'Globex', prefix: 'GLOBEX' },
    ]);

    queue = new Queue(QUEUE_NAMES.outbox, {
      connection: { host: redis.getHost(), port: redis.getPort() },
    });
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
    for (const brandId of [brandA, brandB]) {
      await withSystem(db, brandId, (tx) => tx.delete(outbox).where(eq(outbox.brandId, brandId)));
    }
  });

  afterAll(async () => {
    await queue?.close();
    await handle?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  it('finds every brand without a tenant context, because `brands` is global', async () => {
    expect([...(await listRelayBrandIds(db))].sort()).toEqual([brandA, brandB].sort());
  });

  it('enqueues nothing for a transaction that rolled back', async () => {
    await expect(
      withSystem(db, brandA, async (tx) => {
        await enqueueOutbox(tx, settingsChanged(brandA));
        throw new Error('the domain change failed');
      }),
    ).rejects.toThrow('the domain change failed');

    expect(await unpublishedIds(brandA)).toEqual([]);
    expect(await runRelayCycle({ db, queue, brandIds: [brandA] })).toMatchObject({ published: 0 });
    expect(await waitingJobIds()).toEqual([]);
  });

  it('turns a committed row into exactly one job, then leaves it alone', async () => {
    const id = await write(brandA);

    expect(await runRelayCycle({ db, queue, brandIds: [brandA] })).toMatchObject({
      published: 1,
      brands: 1,
      skipped: 0,
    });

    const job = await queue.getJob(id);
    expect(job?.name).toBe('outbox.event');
    expect(job?.data).toMatchObject({ outboxId: id, brandId: brandA, event: 'settings.changed' });
    expect(job?.opts.attempts).toBe(5);

    expect(await unpublishedIds(brandA)).toEqual([]);
    expect(await runRelayCycle({ db, queue, brandIds: [brandA] })).toMatchObject({ published: 0 });
    expect(await waitingJobIds()).toEqual([id]);
  });

  it('loses nothing when it is killed between the add and the commit', async () => {
    const id = await write(brandA);

    const crashing: JobQueue = {
      add: async (name, data, options) => {
        await queue.add(name, data, options);
        throw new Error('relay killed after the add and before the commit');
      },
    };

    await expect(publishBrand({ db, queue: crashing, brandId: brandA })).rejects.toThrow(
      'relay killed after the add',
    );

    // The job is in Redis and the row is still unpublished: the crash window.
    expect(await waitingJobIds()).toEqual([id]);
    expect(await unpublishedIds(brandA)).toEqual([id]);

    // The next cycle adds the same job id again, which BullMQ ignores.
    expect(await runRelayCycle({ db, queue, brandIds: [brandA] })).toMatchObject({ published: 1 });
    expect(await waitingJobIds()).toEqual([id]);
    expect(await unpublishedIds(brandA)).toEqual([]);
  });

  it('stands down while another replica holds the brand lock', async () => {
    await write(brandA);

    let acquired: () => void = () => {};
    let release: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const otherReplica = withSystem(db, brandA, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${OUTBOX_RELAY_LOCK_NAMESPACE}::int, ${advisoryLockKey(brandA)}::int)`,
      );
      acquired();
      await released;
    });

    await locked;
    expect(await publishBrand({ db, queue, brandId: brandA })).toEqual({
      published: 0,
      skipped: true,
    });
    expect(await waitingJobIds()).toEqual([]);

    release();
    await otherReplica;

    expect(await publishBrand({ db, queue, brandId: brandA })).toEqual({
      published: 1,
      skipped: false,
    });
  });

  it('publishes each row once when two relays run at the same time', async () => {
    const ids = [await write(brandA), await write(brandA), await write(brandA)];

    const [first, second] = await Promise.all([
      runRelayCycle({ db, queue, brandIds: [brandA] }),
      runRelayCycle({ db, queue, brandIds: [brandA] }),
    ]);

    expect(first.published + second.published).toBe(ids.length);
    expect([...(await waitingJobIds())].sort()).toEqual([...ids].sort());
    expect(await unpublishedIds(brandA)).toEqual([]);
  });

  it('never reaches another brand, even in the discovery query', async () => {
    const idA = await write(brandA);
    const idB = await write(brandB);

    expect(await findUnpublishedRowCounts(db, [brandA])).toEqual([{ brandId: brandA, rows: 1 }]);
    expect(await runRelayCycle({ db, queue, brandIds: [brandA] })).toMatchObject({
      published: 1,
      pending: 1,
    });

    expect(await waitingJobIds()).toEqual([idA]);
    expect(await queue.getJob(idB)).toBeUndefined();
    expect(await unpublishedIds(brandB)).toEqual([idB]);
  });

  it('wakes on a LISTEN outbox notification rather than waiting for the poll', async () => {
    const relay = startOutboxRelay({
      db,
      redis: { host: redis.getHost(), port: redis.getPort() },
      listenUrl: appUrl,
      // Long enough that a poll cannot be what published the row.
      pollIntervalMs: 60_000,
      brandIds: [brandA],
    });

    try {
      // The relay runs one cycle as it starts. Letting it finish and fall asleep
      // first is what makes the assertion below about the notification rather
      // than about that first cycle.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const id = await write(brandA);

      await vi.waitFor(
        async () => {
          expect(await queue.getJob(id)).toBeDefined();
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await relay.stop();
    }
  });

  it('reports every cycle to Redis, so the api can say the worker is alive', async () => {
    const connection = createQueueConnection(redis.getConnectionUrl());
    await write(brandA);

    const relay = startOutboxRelay({
      db,
      redis: connection,
      status: connection,
      brandIds: [brandA],
      pollIntervalMs: 200,
    });

    try {
      const reported = await vi.waitFor(
        async () => {
          const status = await readRelayStatus(connection);
          expect(status).not.toBeNull();
          return status;
        },
        { timeout: 10_000, interval: 50 },
      );

      // The first cycle found the row waiting and published it, which is what
      // the System page's "n pending · last cycle x ago" is built from.
      expect(reported).toMatchObject({ pending: 1, published: 1, brands: 1, failed: 0 });
      expect(Date.parse(reported?.at ?? '')).toBeGreaterThan(Date.now() - 30_000);

      // A later cycle overwrites it with an empty backlog.
      await vi.waitFor(
        async () => {
          expect(await readRelayStatus(connection)).toMatchObject({ pending: 0, published: 0 });
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await relay.stop();
      await connection.quit();
    }
  });
});
