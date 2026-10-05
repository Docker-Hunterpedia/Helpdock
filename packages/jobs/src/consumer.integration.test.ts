import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_ROLE_NAME,
  auditLog,
  brands,
  createDb,
  type Db,
  type DbHandle,
  jobReceipts,
  outbox,
  runMigrations,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { type Job, Queue, type Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorker, type JobHandler } from './consumer.js';
import {
  createOutboxDispatcher,
  createOutboxEventHandler,
  outboxJobOrderingKeys,
  SETTINGS_CHANGED_EVENT,
} from './dispatcher.js';
import { type OutboxEventPayload, outboxEventJob } from './jobs.js';
import type { JobLogger } from './logger.js';
import { enqueueOutbox } from './outbox.js';
import { QUEUE_NAMES } from './queues.js';
import { createQueueConnection } from './redis.js';
import { runRelayCycle } from './relay.js';

/**
 * The consumer half of DOMAIN-RULES §6: at-least-once delivery made
 * exactly-once by `job_receipts`. A handler that fails leaves no trace and runs
 * again; a handler that succeeds leaves a receipt that stops every redelivery;
 * a payload that cannot be parsed is not retried at all.
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
    'Skipping the outbox consumer tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const brandId = uuidv7();

interface LogLine {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const recordingLogger = (): JobLogger & { readonly lines: LogLine[] } => {
  const lines: LogLine[] = [];
  const record = (fields: Record<string, unknown>, message: string): void => {
    lines.push({ fields, message });
  };
  return { lines, info: record, warn: record, error: record };
};

describe.skipIf(!hasDocker)('idempotent consumers', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let handle: DbHandle;
  let db: Db;
  let queue: Queue;
  let connection: Redis;
  let workers: Worker[];

  const start = (handler: JobHandler<OutboxEventPayload>, log: JobLogger): Worker => {
    const worker = createWorker(outboxEventJob, handler, { redis: connection, db, log });
    workers.push(worker);
    return worker;
  };

  /** Writes an outbox row and lets the relay publish it, which is the only real path. */
  const publish = async (event: string): Promise<string> => {
    const id = await withSystem(db, brandId, (tx) =>
      enqueueOutbox(tx, { brandId, event, payload: { key: 'smtp.host' } }),
    );
    await runRelayCycle({ db, queue, brandIds: [brandId] });
    return id;
  };

  // `queue.getJob` is a snapshot while `getState` reads live, so the state can
  // already be settled while `failedReason` / `attemptsMade` on the snapshot are
  // stale. Wait on the state, then load the job again so its fields are final.
  const settledJob = async (id: string, state: 'completed' | 'failed'): Promise<Job> => {
    await vi.waitFor(
      async () => {
        const job = await queue.getJob(id);
        expect(await job?.getState()).toBe(state);
      },
      { timeout: 20_000, interval: 50 },
    );
    const settled = await queue.getJob(id);
    if (settled === undefined) {
      throw new Error(`job ${id} disappeared after settling as ${state}`);
    }
    return settled;
  };

  const auditRows = () =>
    withSystem(db, brandId, (tx) =>
      tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.brandId, brandId)),
    );

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

    handle = createDb({
      url: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
    });
    db = handle.db;
    await db.insert(brands).values({ id: brandId, name: 'Acme', prefix: 'ACME' });

    connection = createQueueConnection(redis.getConnectionUrl());
    queue = new Queue(QUEUE_NAMES.outbox, { connection });
    workers = [];
  });

  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    workers = [];
    await queue.obliterate({ force: true });
    await withSystem(db, brandId, async (tx) => {
      await tx.delete(outbox).where(eq(outbox.brandId, brandId));
      await tx.delete(auditLog).where(eq(auditLog.brandId, brandId));
    });
    await db.delete(jobReceipts);
  });

  afterAll(async () => {
    await queue?.close();
    await connection?.quit();
    await handle?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  it('runs the side effect once when the handler throws and then succeeds', async () => {
    let attempts = 0;
    const log = recordingLogger();

    start(async ({ tx, brandId: brand }) => {
      attempts += 1;
      await tx.insert(auditLog).values({
        brandId: brand,
        actorType: 'system',
        actorId: 'worker',
        action: 'test.effect',
        targetType: 'test',
      });
      if (attempts === 1) {
        throw new Error('smtp is down');
      }
    }, log);

    const id = await publish('ticket.replied');
    const job = await settledJob(id, 'completed');

    expect(attempts).toBe(2);
    expect(job.attemptsMade).toBe(2);
    // The failed attempt wrote its row in the transaction that rolled back, so
    // the effect and the receipt are all-or-nothing together.
    expect(await auditRows()).toEqual([{ action: 'test.effect' }]);
    expect(await db.select({ key: jobReceipts.key }).from(jobReceipts)).toEqual([
      { key: `outbox.event:${id}` },
    ]);
  });

  it('runs the handler once when the same outbox row is delivered twice', async () => {
    const handler = vi.fn<JobHandler<OutboxEventPayload>>().mockResolvedValue(undefined);
    const log = recordingLogger();
    start(handler, log);

    const id = await publish('ticket.replied');
    await settledJob(id, 'completed');

    // A redelivery after the first job left Redis: a new BullMQ job id, the same
    // outbox row, so the natural key is what stops it.
    const redelivery = uuidv7();
    await queue.add(
      outboxEventJob.name,
      { outboxId: id, brandId, event: 'ticket.replied', payload: { key: 'smtp.host' } },
      { ...outboxEventJob.options, jobId: redelivery },
    );
    await settledJob(redelivery, 'completed');

    expect(handler).toHaveBeenCalledOnce();
    expect(log.lines.map((line) => line.message)).toContain(
      'duplicate delivery ignored; its receipt is already claimed',
    );
  });

  it('fails an invalid payload with the Zod issues and does not retry it', async () => {
    const handler = vi.fn<JobHandler<OutboxEventPayload>>().mockResolvedValue(undefined);
    start(handler, recordingLogger());

    const id = uuidv7();
    await queue.add(
      outboxEventJob.name,
      { outboxId: id, brandId: 'not-a-uuid', event: 'Nope' },
      { ...outboxEventJob.options, jobId: id },
    );

    const job = await settledJob(id, 'failed');

    expect(job.failedReason).toContain('brandId');
    expect(job.failedReason).toContain('event');
    expect(job.attemptsMade).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(await db.select({ key: jobReceipts.key }).from(jobReceipts)).toEqual([]);
  });

  it('dispatches a published row to the handler registered for its event', async () => {
    const log = recordingLogger();
    start(createOutboxEventHandler(), log);

    const id = await publish(SETTINGS_CHANGED_EVENT);
    await settledJob(id, 'completed');

    expect(log.lines.map((line) => line.message)).toContain('settings changed');
    expect(log.lines.find((line) => line.message === 'settings changed')?.fields).toMatchObject({
      brandId,
      key: 'smtp.host',
    });
  });

  it('fails an event no handler is registered for, naming the ones that are', async () => {
    start(createOutboxEventHandler(), recordingLogger());

    const id = uuidv7();
    await queue.add(
      outboxEventJob.name,
      { outboxId: id, brandId, event: 'ticket.replied', payload: {} },
      // The definition's exponential backoff would spend fifteen seconds proving
      // a point the attempt count already makes.
      { ...outboxEventJob.options, jobId: id, backoff: { type: 'fixed', delay: 20 } },
    );

    const job = await settledJob(id, 'failed');

    expect(job.failedReason).toContain('No outbox handler is registered for ticket.replied');
    expect(job.attemptsMade).toBe(outboxEventJob.options.attempts);
  });

  describe('per-ticket order under concurrency', () => {
    const TICKETS = [uuidv7(), uuidv7(), uuidv7()];
    const EVENTS_PER_TICKET = 8;

    interface Run {
      readonly ticketId: string;
      readonly n: number;
      readonly startedAt: number;
      readonly endedAt: number;
    }

    /** A subscriber that sleeps a little, as a real one waits on the database, and records when. */
    const recordingDispatcher = (runs: Run[]) => {
      const dispatcher = createOutboxDispatcher();
      dispatcher.register('ticket.updated', async ({ payload }) => {
        const startedAt = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25));
        runs.push({
          ticketId: String(payload.ticketId),
          n: Number(payload.n),
          startedAt,
          endedAt: performance.now(),
        });
      });
      return dispatcher;
    };

    /** Round-robin across the tickets, so each ticket's events are interleaved with the others'. */
    const publishInterleaved = async (): Promise<void> => {
      await withSystem(db, brandId, async (tx) => {
        for (let n = 0; n < EVENTS_PER_TICKET; n += 1) {
          for (const ticketId of TICKETS) {
            await enqueueOutbox(tx, { brandId, event: 'ticket.updated', payload: { ticketId, n } });
          }
        }
      });
      await runRelayCycle({ db, queue, brandIds: [brandId] });
    };

    const waitForAll = (runs: Run[]) =>
      vi.waitFor(
        () => {
          expect(runs).toHaveLength(TICKETS.length * EVENTS_PER_TICKET);
        },
        { timeout: 30_000, interval: 50 },
      );

    const overlapsWithinATicket = (runs: readonly Run[]): boolean =>
      TICKETS.some((ticketId) => {
        const mine = runs
          .filter((run) => run.ticketId === ticketId)
          .sort((a, b) => a.startedAt - b.startedAt);
        return mine.some(
          (run, index) => index > 0 && run.startedAt < (mine[index - 1]?.endedAt ?? 0),
        );
      });

    const mostAtOnce = (runs: readonly Run[]): number =>
      Math.max(
        ...runs.map(
          (run) =>
            runs.filter((other) => other.startedAt < run.endedAt && other.endedAt > run.startedAt)
              .length,
        ),
      );

    it('runs one ticket’s events one at a time, in the order they were written', async () => {
      const runs: Run[] = [];
      workers.push(
        createWorker(outboxEventJob, createOutboxEventHandler(recordingDispatcher(runs)), {
          redis: connection,
          db,
          log: recordingLogger(),
          concurrency: 8,
          serialize: outboxJobOrderingKeys,
        }),
      );

      await publishInterleaved();
      await waitForAll(runs);

      for (const ticketId of TICKETS) {
        expect(runs.filter((run) => run.ticketId === ticketId).map((run) => run.n)).toEqual(
          Array.from({ length: EVENTS_PER_TICKET }, (_unused, n) => n),
        );
      }
      expect(overlapsWithinATicket(runs)).toBe(false);
      // …and different tickets did run side by side, which is the point.
      expect(mostAtOnce(runs)).toBeGreaterThan(1);
    });

    it('never runs two events of one ticket at once across two worker processes', async () => {
      const runs: Run[] = [];
      for (let replica = 0; replica < 2; replica += 1) {
        workers.push(
          createWorker(outboxEventJob, createOutboxEventHandler(recordingDispatcher(runs)), {
            redis: connection,
            db,
            log: recordingLogger(),
            concurrency: 4,
            serialize: outboxJobOrderingKeys,
          }),
        );
      }

      await publishInterleaved();
      await waitForAll(runs);

      expect(overlapsWithinATicket(runs)).toBe(false);
    });
  });
});
